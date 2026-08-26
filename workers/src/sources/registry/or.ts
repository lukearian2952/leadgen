// Oregon — data.oregon.gov `tckn-sxa6`, "Active Businesses - ALL".
//
// Verified live 2026-08-26: 1,574,078 rows, and the dataset is already scoped
// to active registrations, so there is no status column to filter on.
//
// ── The shape that matters ───────────────────────────────────────────────────
//
// Oregon publishes **one row per associated name**, not one row per business.
// A single registry number appears up to four times:
//
//   PRINCIPAL PLACE OF BUSINESS  559,498   the entity's own address
//   REGISTERED AGENT             449,462   person or company
//   MAILING ADDRESS              447,774   an address, never a name
//   AUTHORIZED REPRESENTATIVE    117,344   person, and the closest thing
//                                          Oregon publishes to a principal
//
// So the adapter groups consecutive rows by `registry_number` and emits one
// entity per group. Groups straddle Socrata page boundaries, which is why the
// last group of a page is carried forward rather than emitted — emitting it
// would split one business into two entities with half its officers each.
//
// ── Person vs company ────────────────────────────────────────────────────────
//
// Oregon answers this itself and does not need a heuristic: a person row has
// `first_name`/`last_name`, a company row has `entity_of_record_name` instead
// ("REGISTERED AGENTS INC", "C T CORPORATION SYSTEM"). Same trust decision as
// CO's `agentorganizationname` and FL's P/C flag.
//
// ── What Oregon does not have ────────────────────────────────────────────────
//
// No officers, directors or members — the authorized representative and the
// registered agent are the only names. And no county column, so `county` is
// resolved from the ZIP through the zip_county crosswalk at match time.

import type { RegistryAdapter, RegistryEntity, RegistryOfficer, IngestScope } from './types.js'
import { SocrataClient, likeAnyClause } from './socrata.js'
import { isCommercialAgent } from '../../lib/registry-name.js'
import { checkFirstName } from '../../lib/identity.js'
import { normaliseName } from '../../lib/normalise.js'
import type { Logger } from '../../logger.js'

const HOST = 'data.oregon.gov'
const DATASET = 'tckn-sxa6'

const SELECT = [
  'registry_number', 'business_name', 'entity_type', 'registry_date',
  'associated_name_type', 'first_name', 'middle_name', 'last_name', 'suffix',
  'entity_of_record_name', 'address', 'city', 'state', 'zip',
].join(',')

/** An address row for the entity itself, in preference order. */
const ADDRESS_TYPES = ['PRINCIPAL PLACE OF BUSINESS', 'MAILING ADDRESS']

/**
 * Rank by role. An authorized representative signed for the business; a
 * registered agent may be nothing more than whoever accepts its mail.
 */
const ROLE_RANK: Record<string, number> = {
  'AUTHORIZED REPRESENTATIVE': 1,
  'REGISTERED AGENT': 5,
}

interface OrRow {
  registry_number?: string
  business_name?: string
  entity_type?: string
  registry_date?: string
  associated_name_type?: string
  first_name?: string
  middle_name?: string
  last_name?: string
  suffix?: string
  entity_of_record_name?: string
  address?: string
  city?: string
  state?: string
  zip?: string
}

export class OrRegistry implements RegistryAdapter {
  readonly state = 'OR'
  readonly name = 'or_socrata'
  private readonly client: SocrataClient

  constructor(appToken: string, private readonly logger: Logger) {
    this.client = new SocrataClient(HOST, DATASET, appToken, logger)
  }

  /**
   * Oregon has no county column and no status column, so the only scope that
   * can be pushed upstream is the entity name.
   */
  private where(scope: IngestScope, nameTokens?: string[]): string {
    return likeAnyClause('business_name', nameTokens ?? scope.nameContains ?? [])
  }

  async *ingest(scope: IngestScope): AsyncIterable<RegistryEntity> {
    const where = this.where(scope)
    this.logger.info('or registry ingest', { where, limit: scope.limit })
    yield* this.stream(where, 1000, scope.limit)
  }

  async *lookup(nameTokens: string[], scope: IngestScope): AsyncIterable<RegistryEntity> {
    if (!nameTokens.length) return
    yield* this.stream(this.where(scope, nameTokens), 200, scope.limit ?? 200)
  }

  /**
   * Page the dataset and emit one entity per `registry_number` group.
   *
   * `limit` bounds *entities*, but Socrata's `$limit` bounds *rows*, and a
   * business is up to four rows. Paging is therefore left unbounded upstream
   * and the ceiling applied here, so a caller asking for 200 businesses gets
   * 200 businesses rather than roughly 60.
   */
  private async *stream(
    where: string, pageSize: number, limit?: number,
  ): AsyncIterable<RegistryEntity> {
    let group: OrRow[] = []
    let groupKey = ''
    let yielded = 0

    for await (const page of this.client.pages({
      select: SELECT, where, order: 'registry_number', pageSize,
    })) {
      for (const raw of page) {
        const row = raw as OrRow
        const key = (row.registry_number ?? '').trim()
        if (!key) continue

        if (key !== groupKey) {
          if (group.length) {
            yield toEntity(group)
            if (limit && ++yielded >= limit) return
          }
          group = []
          groupKey = key
        }
        group.push(row)
      }
      // The final group of a page is deliberately not emitted here: its
      // remaining rows are the first rows of the next page.
    }

    if (group.length && (!limit || yielded < limit)) yield toEntity(group)
  }
}

/** One `registry_number` group → one entity. */
export function toEntity(group: OrRow[]): RegistryEntity {
  const head = group[0]
  const entityName = (head.business_name ?? '').trim()

  const address = ADDRESS_TYPES
    .map(t => group.find(r => (r.associated_name_type ?? '').toUpperCase() === t))
    .find(Boolean) ?? head

  const officers: RegistryOfficer[] = []
  for (const row of group) {
    const role = (row.associated_name_type ?? '').toUpperCase()
    const rank = ROLE_RANK[role]
    if (rank === undefined) continue

    // A company agent carries `entity_of_record_name` and no person columns.
    // The dataset's own answer; no heuristic needed.
    if ((row.entity_of_record_name ?? '').trim()) continue

    const first = (row.first_name ?? '').trim()
    const last = (row.last_name ?? '').trim()
    if (!first || !last) continue
    if (checkFirstName(first)) continue
    if (isCommercialAgent(`${first} ${last}`)) continue

    officers.push({
      name: [first, row.middle_name?.trim(), last, row.suffix?.trim()]
        .filter(Boolean).join(' '),
      title: role === 'AUTHORIZED REPRESENTATIVE' ? 'Authorized Representative'
                                                  : 'Registered Agent',
      first: titleCase(first),
      last: titleCase(last),
      kind: 'person',
      source_field: role === 'AUTHORIZED REPRESENTATIVE'
        ? 'authorized_representative' : 'registered_agent',
      rank,
    })
  }

  // The same person can be both the agent and the representative; keep the
  // better-ranked row so a match does not report the same name twice.
  const seen = new Map<string, RegistryOfficer>()
  for (const o of officers.sort((a, b) => a.rank - b.rank)) {
    const key = `${o.first.toLowerCase()}|${o.last.toLowerCase()}`
    if (!seen.has(key)) seen.set(key, o)
  }

  return {
    state: 'OR',
    entityId: (head.registry_number ?? '').trim(),
    name: entityName,
    nameNorm: normaliseName(entityName),
    // The dataset is published as the active-business extract; there is no
    // status column to read and every row in it is active by construction.
    status: 'Active',
    entityType: (head.entity_type ?? '').trim(),
    // Filled from zip_county at match time — Oregon publishes no county.
    county: '',
    city: (address.city ?? '').trim(),
    stateCode: (address.state ?? 'OR').trim(),
    postalCode: (address.zip ?? '').trim(),
    street: (address.address ?? '').trim(),
    filingDate: (head.registry_date ?? '').slice(0, 10) || null,
    officers: [...seen.values()],
    raw: {
      associated_name_types: group.map(r => r.associated_name_type ?? null),
      entity_of_record_names: group
        .map(r => (r.entity_of_record_name ?? '').trim()).filter(Boolean),
    },
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}
