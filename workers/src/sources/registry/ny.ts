// New York — data.ny.gov `n9v6-gdp6`, "Active Corporations: Beginning 1800".
//
// Verified live 2026-08-16 and again 2026-08-17: 4,266,351 rows. Field
// population re-measured independently of ARCHITECTURE.md §4B and agreeing
// with it exactly:
//
//   dos_process_name       4,194,633   98.3%
//   registered_agent_name    870,927   20.4%
//   chairman_name            473,947   11.1%
//   location_city            355,413    8.3%
//
// `county` is title-case ('Nassau'), 100% populated, and is the join key —
// `location_city` at 8.3% cannot be one. Nassau alone holds 405,947 entities.
//
// Three name columns, none of which is reliably a person. Everything they
// yield goes through classifyRegistryName, which rejects the entity name
// repeated back (53–56% of dos_process_name) and commercial agents before
// asking parseName whether what remains is human.

import type { RegistryAdapter, RegistryEntity, RegistryOfficer, IngestScope } from './types.js'
import { SocrataClient, likeAnyClause, inClause, andClauses } from './socrata.js'
import { classifyRegistryName, NY_FIELD_RANK } from '../../lib/registry-name.js'
import { normaliseName } from '../../lib/normalise.js'
import type { Logger } from '../../logger.js'

const HOST = 'data.ny.gov'
const DATASET = 'n9v6-gdp6'

/** Only the columns we read, so pages stay small over 400k-row counties. */
const SELECT = [
  'dos_id', 'current_entity_name', 'initial_dos_filing_date', 'county',
  'jurisdiction', 'entity_type', 'dos_process_name', 'dos_process_address_1',
  'dos_process_city', 'dos_process_state', 'dos_process_zip',
  'registered_agent_name', 'chairman_name',
  'location_city', 'location_zip', 'location_address_1',
].join(',')

interface NyRow {
  dos_id?: string
  current_entity_name?: string
  initial_dos_filing_date?: string
  county?: string
  entity_type?: string
  dos_process_name?: string
  dos_process_address_1?: string
  dos_process_city?: string
  dos_process_state?: string
  dos_process_zip?: string
  registered_agent_name?: string
  chairman_name?: string
  location_city?: string
  location_zip?: string
  location_address_1?: string
}

export class NyRegistry implements RegistryAdapter {
  readonly state = 'NY'
  readonly name = 'ny_socrata'
  private readonly client: SocrataClient

  constructor(appToken: string, private readonly logger: Logger) {
    this.client = new SocrataClient(HOST, DATASET, appToken, logger)
  }

  private where(scope: IngestScope): string {
    return andClauses(
      inClause('county', scope.counties ?? []),
      likeAnyClause('current_entity_name', scope.nameContains ?? []),
    )
  }

  async *ingest(scope: IngestScope): AsyncIterable<RegistryEntity> {
    const where = this.where(scope)
    this.logger.info('ny registry ingest', { where, limit: scope.limit })

    for await (const page of this.client.pages({
      select: SELECT, where, order: 'dos_id',
      pageSize: scope.pageSize ?? 1000, limit: scope.limit,
    })) {
      for (const row of page) yield toEntity(row as NyRow)
    }
  }

  /**
   * One request, name tokens OR-ed inside the campaign's counties. This is what
   * makes coverage independent of whatever niche keywords the bulk slice used:
   * a business called "Brizel Med Spa" is found by its distinctive token
   * BRIZEL even if the slice only asked for SPA.
   */
  async *lookup(nameTokens: string[], scope: IngestScope): AsyncIterable<RegistryEntity> {
    if (!nameTokens.length) return
    const where = andClauses(
      inClause('county', scope.counties ?? []),
      likeAnyClause('current_entity_name', nameTokens),
    )
    if (!where) return

    for await (const page of this.client.pages({
      select: SELECT, where, order: 'dos_id', pageSize: 200, limit: scope.limit ?? 200,
    })) {
      for (const row of page) yield toEntity(row as NyRow)
    }
  }

  count(scope: IngestScope): Promise<number> {
    return this.client.count(this.where(scope))
  }
}

function toEntity(row: NyRow): RegistryEntity {
  const entityName = (row.current_entity_name ?? '').trim()

  // Field order is the brief's: dos_process_name → chairman → registered agent.
  // See the note on NY_FIELD_RANK in lib/registry-name.ts about what the data
  // says versus what the brief specifies.
  const officers: RegistryOfficer[] = []
  const fields: Array<[keyof NyRow, string, string]> = [
    ['dos_process_name', 'dos_process_name', 'Process Agent'],
    ['chairman_name', 'chairman_name', 'CEO / Chairman'],
    ['registered_agent_name', 'registered_agent_name', 'Registered Agent'],
  ]

  for (const [key, field, title] of fields) {
    const value = (row[key] ?? '').toString().trim()
    if (!value) continue
    const classified = classifyRegistryName(value, entityName)
    if (classified.kind !== 'person') continue
    officers.push({
      name: value,
      title,
      first: classified.first,
      last: classified.last,
      kind: 'person',
      source_field: field,
      rank: NY_FIELD_RANK[field] ?? 9,
    })
  }
  officers.sort((a, b) => a.rank - b.rank)

  // The address that best locates the entity. `location_*` is the real business
  // address but is only 8.3% populated, so `dos_process_*` (99.8%) is the
  // fallback — it is where the state sends legal service, which for a small
  // owner-operated business is usually the business itself.
  const city = (row.location_city ?? row.dos_process_city ?? '').trim()
  const zip = (row.location_zip ?? row.dos_process_zip ?? '').trim()
  const street = (row.location_address_1 ?? row.dos_process_address_1 ?? '').trim()

  return {
    state: 'NY',
    entityId: (row.dos_id ?? '').trim(),
    name: entityName,
    nameNorm: normaliseName(entityName),
    status: 'Active',
    entityType: (row.entity_type ?? '').trim(),
    county: (row.county ?? '').trim(),
    city,
    stateCode: (row.dos_process_state ?? 'NY').trim(),
    postalCode: zip,
    street,
    filingDate: (row.initial_dos_filing_date ?? '').slice(0, 10) || null,
    officers,
    raw: {
      dos_process_name: row.dos_process_name ?? null,
      chairman_name: row.chairman_name ?? null,
      registered_agent_name: row.registered_agent_name ?? null,
      dos_process_city: row.dos_process_city ?? null,
      dos_process_zip: row.dos_process_zip ?? null,
    },
  }
}
