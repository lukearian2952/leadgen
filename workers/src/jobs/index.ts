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

export interface TaskDeps {
  config: Config
  db: Pool
  logger: Logger
}

/** Which roles run which stages. 'all' runs everything. */
const ROLE_STAGES: Record<Exclude<WorkerRole, 'all'>, string[]> = {
  maps:      ['maps:discover'],
  serp:      ['serp:search'],
  crawl:     ['crawl:site'],
  linkedin:  ['linkedin:company', 'linkedin:person'],
  registry:  ['registry:match', 'registry:ingest'],
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

    'verify:batch': makeVerifyBatchTask(deps),
  }

  // `ping` is always registered — it is how health checks and the smoke test
  // confirm a worker is consuming, regardless of role.
  const selected: TaskList = { ping: all.ping }
  for (const [name, task] of Object.entries(all)) {
    if (wanted.has(name)) selected[name] = task
  }
  return selected
}
