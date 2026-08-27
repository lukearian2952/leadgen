// Task registry.
//
// Phase 1 ships the plumbing, not the pipeline: `ping` proves the queue round
// trips, and `verify:batch` is the first real stage because the verifier is the
// piece Phase 1 has to demonstrate working. Sources land in Phase 2.
//
// Which tasks a container registers depends on WORKER_ROLE, so `docker compose
// up --scale crawl-worker=4` scales only the crawl stage.

import type { TaskList } from 'graphile-worker'
import type { Pool } from 'pg'
import type { Config, WorkerRole } from '../config.js'
import type { Logger } from '../logger.js'
import { wrapTask } from './wrap.js'
import { makeVerifyBatchTask } from './verify-batch.js'
import { makeMapsDiscoverTask } from './maps-discover.js'
import { makeSaasDiscoverTask } from './saas-discover.js'
import { makeCrawlSiteTask } from './crawl-site.js'
import { makeEnrichLeadTask } from './enrich-lead.js'
import { makeReconcileTask } from './reconcile.js'
import { makeRegistryIngestTask } from './registry-ingest.js'
import { makeRegistryMatchTask } from './registry-match.js'
import { makeRegistryRefreshTask } from './registry-refresh.js'
import { makeSerpOwnerTask } from './serp-owner.js'

export interface TaskDeps {
  config: Config
  /** Supabase: leads, campaigns, job bookkeeping. Every stage uses this. */
  db: Pool
  /**
   * registry-db: `registry_entities` and `zip_county`, on local disk.
   *
   * Null for roles that do not read the registry. `registry:match` and
   * `registry:ingest` fail loudly rather than silently degrading when it is
   * missing — a matcher that quietly finds nothing looks exactly like a niche
   * with no registry coverage, which is a conclusion this project has already
   * drawn wrongly once.
   */
  registryDb: Pool | null
  logger: Logger
}

/** The registry pool, or a clear explanation of why there isn't one. */
export function requireRegistryDb(deps: TaskDeps): Pool {
  if (deps.registryDb) return deps.registryDb
  throw new Error(
    'registry-db is not configured. Set REGISTRY_DATABASE_URL and start the ' +
    '`registry-db` service — the registries moved out of Supabase when the ' +
    'free plan\'s 500 MB ceiling made whole-state slices impossible.')
}

/** Which roles run which stages. 'all' runs everything. */
const ROLE_STAGES: Record<Exclude<WorkerRole, 'all'>, string[]> = {
  maps:      ['maps:discover', 'saas:discover'],
  serp:      ['serp:owner'],
  crawl:     ['crawl:site'],
  linkedin:  ['linkedin:company', 'linkedin:person'],
  registry:  ['registry:match', 'registry:ingest', 'registry:refresh'],
  enrich:    ['enrich:lead'],
  verify:    ['verify:batch'],
  scheduler: ['campaign:reconcile'],
}

export function stagesForRole(role: WorkerRole): string[] {
  if (role === 'all') return Object.values(ROLE_STAGES).flat()
  return ROLE_STAGES[role] ?? []
}

export function buildTaskList(deps: TaskDeps): TaskList {
  const { config, db } = deps
  const wanted = new Set(stagesForRole(config.role))

  const all: TaskList = {
    // Liveness probe for the queue itself. The Phase 1 smoke test enqueues one
    // of these and asserts it is picked up — which proves DATABASE_URL_DIRECT
    // really is a session-mode connection and LISTEN/NOTIFY works.
    'ping': wrapTask({ stage: 'ping', db }, async (payload, ctx) => {
      ctx.cost.detail = { echo: payload.echo ?? null }
      ctx.logger.info('ping', { echo: payload.echo ?? null })
    }),

    'verify:batch':       makeVerifyBatchTask(deps),
    'maps:discover':      makeMapsDiscoverTask(deps),
    // Discovery for niches with no storefront. Search-based; see
    // sources/saas.ts for why the SaaS directories are not crawled.
    'saas:discover':      makeSaasDiscoverTask(deps),
    'crawl:site':         makeCrawlSiteTask(deps),
    // Phase 3 naming stages. The chain is
    //   crawl:site → registry:match → [serp:owner] → enrich:lead
    // with registry:match deciding whether SERP is worth buying for a lead.
    'registry:ingest':    makeRegistryIngestTask(deps),
    'registry:match':     makeRegistryMatchTask(deps),
    // Weekly, from the crontab. Re-runs whatever slice is already loaded.
    'registry:refresh':   makeRegistryRefreshTask(deps),
    'serp:owner':         makeSerpOwnerTask(deps),
    'enrich:lead':        makeEnrichLeadTask(deps),
    'campaign:reconcile': makeReconcileTask(deps),
  }

  // `ping` is always registered — it is how health checks and the smoke test
  // confirm a worker is consuming, regardless of role.
  const selected: TaskList = { ping: all.ping }
  for (const [name, task] of Object.entries(all)) {
    if (wanted.has(name)) selected[name] = task
  }
  return selected
}
