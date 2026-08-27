// registry:refresh — re-ingest every state that already has a slice loaded.
//
// ── Where the scope comes from ───────────────────────────────────────────────
//
// A registry slice is **niche-scoped**: `registry:ingest` pulls only entities
// whose name matches the niche's tokens. So a refresh needs to know which
// tokens, and inventing a fixed list here would quietly diverge from whatever
// is actually loaded — the failure that made a car-wrap campaign match against
// a med-spa slice and read as a ceiling rather than a scoping mistake.
//
// Instead the scope is read back out of `job_runs.detail`, which
// `registry:ingest` already writes on every successful run. The refresh is
// therefore definitionally "re-run what is loaded", and it needs no
// configuration of its own and cannot drift from reality.
//
// A state that has never been ingested is not refreshed. Adding a state is a
// deliberate act, not something a weekly job should start doing on its own.
//
// ── Disk ─────────────────────────────────────────────────────────────────────
//
// Each enqueued ingest carries the same `REGISTRY_MAX_DB_MB` ceiling as a
// manual one, so a refresh cannot fill the database any more than the original
// ingest could. Refreshes are enqueued **one state at a time, serially spaced**,
// rather than all at once: five concurrent ingests would each check the size
// ceiling against a database the other four are still writing to, and all five
// could pass the check on their way past it.

import type { Task } from 'graphile-worker'
import { wrapTask } from './wrap.js'
import type { TaskDeps } from './index.js'
import { SUPPORTED_STATES } from '../sources/registry/index.js'

interface Payload {
  /** Restrict to these states. Default: every state with a slice loaded. */
  states?: string[]
  [key: string]: unknown
}

/**
 * Minutes between successive state ingests.
 *
 * FL's quarterly pull is a 1.8 GB download and roughly fourteen minutes of
 * parsing; the Socrata states are under two. Twenty minutes keeps them from
 * overlapping without needing them to coordinate.
 */
const STAGGER_MINUTES = 20

interface LastScope {
  state: string
  nameContains: string[]
  mode: string | null
}

export function makeRegistryRefreshTask(deps: TaskDeps): Task {
  const { db } = deps

  return wrapTask<Payload>({ stage: 'registry:refresh', db }, async (payload, ctx) => {
    const wanted = new Set(
      (payload.states ?? SUPPORTED_STATES).map(s => s.toUpperCase()))

    // The most recent *successful* ingest per state, and the scope it used.
    // `distinct on` takes the newest row per state in one pass.
    const { rows } = await db.query<{
      state: string; name_contains: unknown; mode: string | null; finished_at: string
    }>(
      `select distinct on (detail->>'state')
              detail->>'state'        state,
              detail->'name_contains' name_contains,
              detail->>'mode'         mode,
              finished_at::text       finished_at
         from job_runs
        where stage = 'registry:ingest'
          and detail->>'state' is not null
          and coalesce((detail->>'complete')::boolean, true)
        order by detail->>'state', finished_at desc`)

    const scopes: LastScope[] = rows
      .filter(r => wanted.has(r.state.toUpperCase()))
      .map(r => ({
        state: r.state.toUpperCase(),
        nameContains: Array.isArray(r.name_contains) ? r.name_contains as string[] : [],
        mode: r.mode,
      }))
      .filter(s => s.nameContains.length > 0)

    if (!scopes.length) {
      ctx.logger.warn('registry refresh found no loaded slice to refresh', {
        wanted: [...wanted],
      })
      ctx.cost.detail = { refreshed: 0, reason: 'no_prior_ingest' }
      return
    }

    let queued = 0
    for (const scope of scopes) {
      const runAt = new Date(Date.now() + queued * STAGGER_MINUTES * 60_000)
      await ctx.helpers.addJob('registry:ingest', {
        state: scope.state,
        nameContains: scope.nameContains,
        ...(scope.mode ? { mode: scope.mode } : {}),
      }, {
        runAt,
        maxAttempts: 2,
        // Same key the manual path uses, so a refresh cannot stack behind a
        // hand-started ingest of the same state — two concurrent FL quarterlies
        // would be 3.6 GB of download for one result.
        jobKey: `registry:ingest:${scope.state}:${scope.mode ?? 'default'}`,
      })
      queued++
    }

    ctx.cost.detail = {
      refreshed: queued,
      states: scopes.map(s => s.state),
      stagger_minutes: STAGGER_MINUTES,
    }
    ctx.logger.info('registry refresh enqueued', ctx.cost.detail)
  })
}
