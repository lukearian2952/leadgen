// Connecticut — data.ct.gov, the Business Registry, published as three
// datasets that must be joined.
//
// Verified live 2026-08-26:
//
//   n7gp-d28j  Business Master      1,293,959 rows  (457,966 Active)
//   ka36-64k6  Principals           1,783,490 rows  firstname / lastname
//   qh2m-n44y  Agents               1,308,817 rows  type: Individual|Business
//
// ── Why the join is worth it ─────────────────────────────────────────────────
//
// CT is the only adapter so far whose person list is *principals* rather than
// agents. NY infers a person from three loosely-typed name columns, CO and OR
// publish the registered agent alone, and a registered agent is very often a
// filing service. A CT principal is the owner or member the business itself
// declared, so the person-per-entity quality is the highest of the set — at
// the cost of two extra requests per page.
//
// ── The master has no usable address ─────────────────────────────────────────
//
// `mailing_address` is present on the schema and is `", , , , ,"` on most rows,
// including active ones. The address therefore comes off the **principal**,
// which carries broken-out `business_*` and `residence_*` columns. That is the
// address the reverse lookup wants in any case: a principal's registered
// address is a real postal address for a person who runs the business.
//
// ── Person vs company ────────────────────────────────────────────────────────
//
// Principals are always people — the dataset has `firstname`/`lastname` and no
// organisation column. Agents carry an explicit `type` of `Individual`,
// `Business` or `Secretary of the State`, and only `Individual` is admitted.
//
// CT publishes no county, so `county` is resolved from the ZIP through the
// zip_county crosswalk at match time.

import type { RegistryAdapter, RegistryEntity, RegistryOfficer, IngestScope } from './types.js'
import { SocrataClient, likeAnyClause, inClause, andClauses } from './socrata.js'
import { isCommercialAgent } from '../../lib/registry-name.js'
import { checkFirstName } from '../../lib/identity.js'
import { normaliseName } from '../../lib/normalise.js'
import type { Logger } from '../../logger.js'

const HOST = 'data.ct.gov'
const MASTER = 'n7gp-d28j'
const PRINCIPALS = 'ka36-64k6'
const AGENTS = 'qh2m-n44y'

const MASTER_SELECT = 'id,name,status,business_type,date_registration,mailing_address'
const PRINCIPAL_SELECT = [
  'business_id', 'firstname', 'lastname',
  'business_street_address_1', 'business_city', 'business_state', 'business_zip_code',
  'residence_street_address_1', 'residence_city', 'residence_state', 'residence_zip_code',
].join(',')
const AGENT_SELECT = [
  'business_key', 'type', 'firstname', 'lastname',
  'business_street_address_1', 'business_city', 'business_state', 'business_zip_code',
].join(',')

/**
 * Master ids per join request.
 *
 * Socrata builds an `in (…)` clause into the query string, and CT ids are 18
 * characters, so 150 ids is roughly a 3 KB URL — comfortably inside limits
 * while keeping the join to one request per 150 businesses instead of one per
 * business.
 */
const JOIN_CHUNK = 150

interface MasterRow {
  id?: string
  name?: string
  status?: string
  business_type?: string
  date_registration?: string
  mailing_address?: string
}

interface PrincipalRow {
  business_id?: string
  firstname?: string
  lastname?: string
  business_street_address_1?: string
  business_city?: string
  business_state?: string
  business_zip_code?: string
  residence_street_address_1?: string
  residence_city?: string
  residence_state?: string
  residence_zip_code?: string
}

interface AgentRow {
  business_key?: string
  type?: string
  firstname?: string
  lastname?: string
  business_street_address_1?: string
  business_city?: string
  business_state?: string
  business_zip_code?: string
}

export class CtRegistry implements RegistryAdapter {
  readonly state = 'CT'
  readonly name = 'ct_socrata'
  private readonly master: SocrataClient
  private readonly principals: SocrataClient
  private readonly agents: SocrataClient

  constructor(appToken: string, private readonly logger: Logger) {
    this.master     = new SocrataClient(HOST, MASTER, appToken, logger)
    this.principals = new SocrataClient(HOST, PRINCIPALS, appToken, logger)
    this.agents     = new SocrataClient(HOST, AGENTS, appToken, logger)
  }

  private where(scope: IngestScope, nameTokens?: string[]): string {
    return andClauses(
      "status = 'Active'",
      likeAnyClause('name', nameTokens ?? scope.nameContains ?? []),
    )
  }

  async *ingest(scope: IngestScope): AsyncIterable<RegistryEntity> {
    const where = this.where(scope)
    this.logger.info('ct registry ingest', { where, limit: scope.limit })
    yield* this.stream(where, 1000, scope.limit)
  }

  async *lookup(nameTokens: string[], scope: IngestScope): AsyncIterable<RegistryEntity> {
    if (!nameTokens.length) return
    yield* this.stream(this.where(scope, nameTokens), 200, scope.limit ?? 200)
  }

  private async *stream(
    where: string, pageSize: number, limit?: number,
  ): AsyncIterable<RegistryEntity> {
    let yielded = 0

    for await (const page of this.master.pages({
      select: MASTER_SELECT, where, order: 'id', pageSize, limit,
    })) {
      const masters = (page as MasterRow[]).filter(m => (m.id ?? '').trim())

      for (let i = 0; i < masters.length; i += JOIN_CHUNK) {
        const chunk = masters.slice(i, i + JOIN_CHUNK)
        const ids = chunk.map(m => (m.id ?? '').trim())

        const [principals, agents] = await Promise.all([
          this.fetchAll<PrincipalRow>(
            this.principals, PRINCIPAL_SELECT, inClause('business_id', ids), 'business_id'),
          this.fetchAll<AgentRow>(
            this.agents, AGENT_SELECT, inClause('business_key', ids), 'business_key'),
        ])

        const byBusiness = new Map<string, PrincipalRow[]>()
        for (const p of principals) {
          const key = (p.business_id ?? '').trim()
          if (!key) continue
          const list = byBusiness.get(key)
          if (list) list.push(p)
          else byBusiness.set(key, [p])
        }
        const agentFor = new Map<string, AgentRow>()
        for (const a of agents) {
          const key = (a.business_key ?? '').trim()
          if (key && !agentFor.has(key)) agentFor.set(key, a)
        }

        for (const master of chunk) {
          const id = (master.id ?? '').trim()
          yield toEntity(master, byBusiness.get(id) ?? [], agentFor.get(id))
          if (limit && ++yielded >= limit) return
        }
      }
    }
  }

  /** Drain every page of a join query into one array. */
  private async fetchAll<T>(
    client: SocrataClient, select: string, where: string, order: string,
  ): Promise<T[]> {
    if (!where) return []
    const out: T[] = []
    for await (const page of client.pages({ select, where, order, pageSize: 1000 })) {
      out.push(...(page as T[]))
    }
    return out
  }
}

export function toEntity(
  master: MasterRow, principals: PrincipalRow[], agent: AgentRow | undefined,
): RegistryEntity {
  const entityName = (master.name ?? '').trim()
  const officers: RegistryOfficer[] = []

  principals.forEach((p, index) => {
    const first = (p.firstname ?? '').trim()
    const last = (p.lastname ?? '').trim()
    if (!first || !last) return
    if (checkFirstName(first)) return
    if (isCommercialAgent(`${first} ${last}`)) return
    officers.push({
      name: `${first} ${last}`,
      title: 'Principal',
      first: titleCase(first),
      last: titleCase(last),
      kind: 'person',
      source_field: 'principal',
      // Principals outrank the agent, then keep the registry's own order.
      rank: 1 + index * 0.01,
    })
  })

  // Only an `Individual` agent is a person. `Business` is a filing service and
  // `Secretary of the State` is the fallback CT assigns itself.
  if ((agent?.type ?? '').trim() === 'Individual') {
    const first = (agent!.firstname ?? '').trim()
    const last = (agent!.lastname ?? '').trim()
    if (first && last && !checkFirstName(first) && !isCommercialAgent(`${first} ${last}`)) {
      officers.push({
        name: `${first} ${last}`,
        title: 'Registered Agent',
        first: titleCase(first),
        last: titleCase(last),
        kind: 'person',
        source_field: 'registered_agent',
        rank: 8,
      })
    }
  }

  // A sole owner is very often their own registered agent, which would
  // otherwise store the same person twice and report them twice on a match.
  const seen = new Map<string, RegistryOfficer>()
  for (const o of officers.sort((a, b) => a.rank - b.rank)) {
    const key = `${o.first.toLowerCase()}|${o.last.toLowerCase()}`
    if (!seen.has(key)) seen.set(key, o)
  }
  const unique = [...seen.values()]

  // The master's `mailing_address` is ", , , , ," on most rows, so the address
  // comes off the first principal that has one, then the agent.
  const source = principals.find(p => (p.business_zip_code ?? p.residence_zip_code ?? '').trim())
  const street = (source?.business_street_address_1 ?? source?.residence_street_address_1
                  ?? agent?.business_street_address_1 ?? '').trim()
  const city = (source?.business_city ?? source?.residence_city
                ?? agent?.business_city ?? '').trim()
  const zip = (source?.business_zip_code ?? source?.residence_zip_code
               ?? agent?.business_zip_code ?? '').trim()

  return {
    state: 'CT',
    entityId: (master.id ?? '').trim(),
    name: entityName,
    nameNorm: normaliseName(entityName),
    status: (master.status ?? '').trim(),
    entityType: (master.business_type ?? '').trim(),
    // Filled from zip_county at match time — CT publishes no county.
    county: '',
    city,
    stateCode: (source?.business_state ?? source?.residence_state ?? 'CT').trim() || 'CT',
    postalCode: zip,
    street,
    filingDate: (master.date_registration ?? '').slice(0, 10) || null,
    officers: unique,
    raw: {
      principal_count: principals.length,
      agent_type: (agent?.type ?? '').trim() || null,
    },
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}
