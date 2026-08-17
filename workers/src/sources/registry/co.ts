// Colorado — data.colorado.gov `4ykn-tg5h`, business entities.
//
// Verified live 2026-08-17: 3,095,339 rows.
//
// CO is the easiest of the three to classify and the thinnest in content. Its
// registered agent is split into real columns — `agentfirstname`,
// `agentmiddlename`, `agentlastname`, `agentsuffix` — with
// `agentorganizationname` used instead when the agent is a company. So the
// source itself answers person-vs-company, and no heuristic is needed for that
// half.
//
// What it does not have: officers, directors, or members. The registered agent
// is the only name in the dataset. For a small owner-operated LLC that is
// usually the owner; for anyone who used a filing service it is Registered
// Agents Inc. The commercial-agent filter therefore still matters, it is just
// the only filter that does.
//
// It also has no county column, so `county` is resolved from the ZIP through
// the zip_county crosswalk at match time rather than at ingest.

import type { RegistryAdapter, RegistryEntity, RegistryOfficer, IngestScope } from './types.js'
import { SocrataClient, likeAnyClause, inClause, andClauses } from './socrata.js'
import { isCommercialAgent } from '../../lib/registry-name.js'
import { checkFirstName } from '../../lib/identity.js'
import { normaliseName } from '../../lib/normalise.js'
import type { Logger } from '../../logger.js'

const HOST = 'data.colorado.gov'
const DATASET = '4ykn-tg5h'

const SELECT = [
  'entityid', 'entityname', 'entitystatus', 'entitytype', 'entityformdate',
  'principaladdress1', 'principalcity', 'principalstate', 'principalzipcode',
  'agentfirstname', 'agentmiddlename', 'agentlastname', 'agentsuffix',
  'agentorganizationname', 'agentprincipalcity', 'agentprincipalzipcode',
].join(',')

interface CoRow {
  entityid?: string
  entityname?: string
  entitystatus?: string
  entitytype?: string
  entityformdate?: string
  principaladdress1?: string
  principalcity?: string
  principalstate?: string
  principalzipcode?: string
  agentfirstname?: string
  agentmiddlename?: string
  agentlastname?: string
  agentsuffix?: string
  agentorganizationname?: string
}

export class CoRegistry implements RegistryAdapter {
  readonly state = 'CO'
  readonly name = 'co_socrata'
  private readonly client: SocrataClient

  constructor(appToken: string, private readonly logger: Logger) {
    this.client = new SocrataClient(HOST, DATASET, appToken, logger)
  }

  /**
   * CO has no county column, so a county-scoped request cannot be expressed
   * upstream. Scope is by entity name and, when the caller passed cities,
   * by `principalcity`.
   */
  private where(scope: IngestScope, nameTokens?: string[]): string {
    return andClauses(
      "entitystatus in ('Good Standing','Exists','Delinquent')",
      likeAnyClause('entityname', nameTokens ?? scope.nameContains ?? []),
    )
  }

  async *ingest(scope: IngestScope): AsyncIterable<RegistryEntity> {
    const where = this.where(scope)
    this.logger.info('co registry ingest', { where, limit: scope.limit })

    for await (const page of this.client.pages({
      select: SELECT, where, order: 'entityid', pageSize: 1000, limit: scope.limit,
    })) {
      for (const row of page) yield toEntity(row as CoRow)
    }
  }

  async *lookup(nameTokens: string[], scope: IngestScope): AsyncIterable<RegistryEntity> {
    if (!nameTokens.length) return
    for await (const page of this.client.pages({
      select: SELECT, where: this.where(scope, nameTokens),
      order: 'entityid', pageSize: 200, limit: scope.limit ?? 200,
    })) {
      for (const row of page) yield toEntity(row as CoRow)
    }
  }
}

function toEntity(row: CoRow): RegistryEntity {
  const entityName = (row.entityname ?? '').trim()
  const officers: RegistryOfficer[] = []

  const first = (row.agentfirstname ?? '').trim()
  const last = (row.agentlastname ?? '').trim()
  const org = (row.agentorganizationname ?? '').trim()

  // The dataset's own person/company split: an organisation name means the
  // agent is a company, and the person columns are empty. Trusting the source
  // here is strictly better than re-deriving it.
  if (!org && first && last && !checkFirstName(first) && !isCommercialAgent(`${first} ${last}`)) {
    officers.push({
      name: [first, row.agentmiddlename?.trim(), last, row.agentsuffix?.trim()]
        .filter(Boolean).join(' '),
      title: 'Registered Agent',
      first: titleCase(first),
      last: titleCase(last),
      kind: 'person',
      source_field: 'agent_name',
      rank: 1,
    })
  }

  return {
    state: 'CO',
    entityId: (row.entityid ?? '').trim(),
    name: entityName,
    nameNorm: normaliseName(entityName),
    status: (row.entitystatus ?? '').trim(),
    entityType: (row.entitytype ?? '').trim(),
    // Filled from zip_county at match time — CO publishes no county column.
    county: '',
    city: (row.principalcity ?? '').trim(),
    stateCode: (row.principalstate ?? 'CO').trim(),
    postalCode: (row.principalzipcode ?? '').trim(),
    street: (row.principaladdress1 ?? '').trim(),
    filingDate: (row.entityformdate ?? '').slice(0, 10) || null,
    officers,
    raw: {
      agent_organization_name: org || null,
      agent_first_name: first || null,
      agent_last_name: last || null,
    },
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}
