// Every job runs inside this wrapper.
//
// It does four things no individual task should have to remember:
//   - opens a `job_runs` row and closes it with the outcome and cost
//   - records duration and status as metrics
//   - writes to `dead_letter` when graphile has exhausted the retries
//   - keeps a per-job logger stamped with campaign/lead/stage
//
// The dead-letter step is the important one. graphile-worker will retry a
// failing job with exponential backoff and then simply leave it in its jobs
// table marked failed, where nothing in the UI can see it. v1's equivalent
// failure mode was a campaign stuck in `running` with no explanation; this
// makes the last attempt land somewhere a human is shown.

import type { Helpers, Task } from 'graphile-worker'
import type { Pool } from 'pg'
import { metrics } from '../metrics.js'
import { rootLogger, type Logger } from '../logger.js'

export interface JobContext {
  logger: Logger
  helpers: Helpers
  db: Pool
  /** Add to this during the job; it is written to job_runs on completion. */
  cost: { cents: number; detail: Record<string, unknown> }
}

export interface BasePayload {
  campaignId?: string
  leadId?: string
  [key: string]: unknown
}

export type JobHandler<P extends BasePayload> = (
  payload: P, ctx: JobContext,
) => Promise<void>

export interface WrapOptions {
  stage: string
  db: Pool
}

export function wrapTask<P extends BasePayload>(
  options: WrapOptions, handler: JobHandler<P>,
): Task {
  const { stage, db } = options

  return async (rawPayload, helpers) => {
    const payload = (rawPayload ?? {}) as P
    const attempt = helpers.job.attempts
    const maxAttempts = helpers.job.max_attempts
    const isFinalAttempt = attempt >= maxAttempts

    const logger = rootLogger.child({
      stage,
      jobId: String(helpers.job.id),
      campaignId: payload.campaignId,
      leadId: payload.leadId,
      attempt,
    })

    const ctx: JobContext = { logger, helpers, db, cost: { cents: 0, detail: {} } }
    const started = Date.now()
    metrics.jobsInFlight.add({ stage }, 1)

    const runId = await openRun(db, stage, payload, attempt, logger)

    try {
      await handler(payload, ctx)

      const seconds = (Date.now() - started) / 1000
      metrics.jobsTotal.inc({ stage, status: 'success' })
      metrics.jobDuration.observe({ stage }, seconds)
      await closeRun(db, runId, 'success', null, ctx, logger)
      logger.info('job finished', { seconds, costCents: ctx.cost.cents })
    } catch (err) {
      const seconds = (Date.now() - started) / 1000
      const message = err instanceof Error ? err.message : String(err)

      metrics.jobsTotal.inc({ stage, status: 'failed' })
      metrics.jobDuration.observe({ stage }, seconds)
      await closeRun(db, runId, 'failed', message, ctx, logger)

      if (isFinalAttempt) {
        metrics.deadLetterTotal.inc({ stage })
        await deadLetter(db, stage, payload, helpers, message, attempt, logger)
        logger.error('job dead-lettered after final attempt', err, { attempt, maxAttempts })
        // Swallow: re-throwing would only mark it failed in graphile's table
        // again, and we have already recorded it somewhere visible.
        return
      }

      logger.warn('job failed, will retry', { attempt, maxAttempts, err: message })
      throw err
    } finally {
      metrics.jobsInFlight.add({ stage }, -1)
    }
  }
}

async function openRun(
  db: Pool, stage: string, payload: BasePayload, attempt: number, logger: Logger,
): Promise<number | null> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into job_runs (campaign_id, lead_id, stage, status, attempt)
       values ($1, $2, $3, 'running', $4)
       returning id`,
      [payload.campaignId ?? null, payload.leadId ?? null, stage, attempt],
    )
    return Number(rows[0].id)
  } catch (err) {
    // Bookkeeping must never take down real work.
    logger.warn('could not open job_runs row', { err: (err as Error).message })
    return null
  }
}

async function closeRun(
  db: Pool, runId: number | null, status: 'success' | 'failed',
  error: string | null, ctx: JobContext, logger: Logger,
): Promise<void> {
  if (runId === null) return
  try {
    await db.query(
      `update job_runs
          set status = $2, error = $3, detail = $4, cost_cents = $5, finished_at = now()
        where id = $1`,
      [runId, status, error?.slice(0, 4000) ?? null,
       JSON.stringify(ctx.cost.detail), ctx.cost.cents],
    )
  } catch (err) {
    logger.warn('could not close job_runs row', { err: (err as Error).message })
  }
}

async function deadLetter(
  db: Pool, stage: string, payload: BasePayload, helpers: Helpers,
  error: string, attempts: number, logger: Logger,
): Promise<void> {
  try {
    await db.query(
      `insert into dead_letter (campaign_id, lead_id, stage, job_key, payload, error, attempts)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        payload.campaignId ?? null,
        payload.leadId ?? null,
        stage,
        helpers.job.key ?? null,
        JSON.stringify(payload),
        error.slice(0, 4000),
        attempts,
      ],
    )
  } catch (err) {
    logger.error('could not write dead_letter row — job failure is now invisible', err)
  }
}

/**
 * Idempotency key. The brief specifies `campaign:lead:stage`, which means
 * re-enqueueing the same work replaces the pending job rather than duplicating
 * it — so "retry all failed" from the UI cannot double-spend.
 */
export function jobKey(stage: string, campaignId?: string, leadId?: string): string {
  return [campaignId ?? 'global', leadId ?? 'all', stage].join(':')
}
