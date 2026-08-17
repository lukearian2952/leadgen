// Release graphile-worker locks held by workers that no longer exist.
//
// ── The trap this closes ─────────────────────────────────────────────────────
//
// graphile-worker locks a job to a worker id. On a clean shutdown the runner
// releases its locks; on SIGKILL — which is what `docker compose up -d` does
// after its stop timeout, and what happens to any worker mid-way through a
// 20-minute scrape — it cannot. The row keeps `locked_by` set to a worker that
// is gone, and nothing runs it again until `jobExpiry` elapses. That default is
// **4 hours**.
//
// This cost a whole discovery run: restarting the fleet during a
// `maps:discover` left the job locked, invisible to every new worker, and it
// had to be cleared out of `graphile_worker._private_jobs` by hand.
//
// ── Why a time threshold, and not something cleverer ─────────────────────────
//
// There is no reliable way to ask "is worker X still alive" from SQL — the id
// is random per process and graphile keeps no heartbeat we can join against.
// So the only sound signal is age: a lock older than any job could legitimately
// hold is a dead lock.
//
// The threshold therefore has to exceed the longest real job. `maps:discover`
// is the long pole and is capped at 45 minutes by `mapsWaitMs`, so the default
// is 60. Setting it below the longest job would let one worker steal a job that
// another is actively running, which is far worse than waiting: two concurrent
// scrapes, double spend, and two writers on the same lead rows.

import type { Pool } from 'pg'
import type { Logger } from './logger.js'

/**
 * Minutes a lock must be held before it is presumed dead.
 *
 * Must stay above `MAPS_WAIT_MAX_MS` (45 min) plus a margin. `STALE_LOCK_MINUTES`
 * overrides it, and values below the floor are refused rather than silently
 * clamped — an operator lowering this is trying to speed up recovery and needs
 * to know it would instead cause double-running.
 */
export const STALE_LOCK_FLOOR_MINUTES = 50
export const STALE_LOCK_DEFAULT_MINUTES = 60

export function staleLockMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STALE_LOCK_MINUTES ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return STALE_LOCK_DEFAULT_MINUTES
  if (raw < STALE_LOCK_FLOOR_MINUTES) {
    throw new Error(
      `STALE_LOCK_MINUTES=${raw} is below the ${STALE_LOCK_FLOOR_MINUTES} minute floor. ` +
      'A threshold under the longest job (maps:discover, up to 45 minutes) would let a ' +
      'second worker take a job that is still running — double spend and two writers on ' +
      'the same rows. Raise it, or shorten MAPS_WAIT_MINUTES first.')
  }
  return raw
}

export interface ReleasedLock {
  taskIdentifier: string
  count: number
}

/**
 * Release presumed-dead locks. Safe to call at every worker boot: with several
 * workers starting together the first one wins and the rest update nothing.
 *
 * Never throws — a bookkeeping step must not stop a worker from starting. The
 * cost of skipping it is the old 4-hour wait, not corruption.
 */
export async function releaseStaleLocks(
  db: Pool, logger: Logger, env: NodeJS.ProcessEnv = process.env,
): Promise<ReleasedLock[]> {
  let minutes: number
  try {
    minutes = staleLockMinutes(env)
  } catch (err) {
    // A misconfiguration here is worth surfacing loudly but is still not a
    // reason to refuse to start.
    logger.error('stale lock threshold rejected — skipping release', err)
    return []
  }

  try {
    const { rows } = await db.query<{ task_identifier: string; n: string }>(
      `with released as (
         update graphile_worker._private_jobs j
            set locked_at = null, locked_by = null
          where j.locked_at is not null
            and j.locked_at < now() - ($1 || ' minutes')::interval
          returning j.task_id
       )
       select t.identifier task_identifier, count(*)::text n
         from released r
         join graphile_worker._private_tasks t on t.id = r.task_id
        group by 1`,
      [String(minutes)])

    const out = rows.map(r => ({ taskIdentifier: r.task_identifier, count: Number(r.n) }))
    if (out.length) {
      logger.warn('released stale job locks from dead workers', {
        thresholdMinutes: minutes,
        released: out,
        note: 'a worker was killed mid-job; these are now runnable again',
      })
    }
    return out
  } catch (err) {
    // The private tables are an internal graphile detail and could be renamed
    // by a major version. Losing this feature is survivable; failing to boot
    // over it is not.
    logger.warn('could not release stale locks', { err: (err as Error).message })
    return []
  }
}
