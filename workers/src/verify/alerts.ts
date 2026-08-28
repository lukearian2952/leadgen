// Operator alerts for conditions that must never degrade silently.
//
// The motivating failure: Verifalia returned 402 for a whole run. Every layer
// behaved correctly and the run still produced nothing, because "the safety net
// is gone" was written only to a log. A condition that invalidates an entire
// run has to reach the UI while the run is still going.

import type { Pool } from 'pg'
import type { Logger } from '../logger.js'

/** Alert kinds. Stable strings — the UI matches on them. */
export const ALERT_VERIFALIA_PAYMENT = 'verifalia_payment_required'
export const ALERT_VERIFALIA_AUTH    = 'verifalia_unauthorized'
export const ALERT_VERIFIER_COOLING  = 'verifier_all_ips_cooling'
export const ALERT_NO_VERIFIER       = 'no_verifier_available'
/**
 * A lead reached a terminal tier without any verifier ever running on it.
 *
 * Found at population scale on 2026-08-28: 20 of 201 Tier C rows had
 * `verifalia_checks: 0`. Their `email_status` was `unknown`, which is the
 * *absence* of a verdict rather than a statement about a mailbox, and at a
 * glance is indistinguishable from "we checked and could not reach it". They
 * were counted as unmailable in every yield figure; re-running them converted
 * **10 of 20 to sendable**, 8 of those Tier A.
 *
 * Nothing was watching for it. The watchdog re-queues `pending_verify`, and
 * these rows were not that — they had been quietly finalised. A tiered row with
 * zero verification checks is a bug, not a result.
 */
export const ALERT_UNVERIFIED_TIERED = 'tiered_rows_unverified'

export type AlertSeverity = 'info' | 'warning' | 'error'

export interface Alert {
  kind: string
  message: string
  severity?: AlertSeverity
  campaignId?: string | null
  detail?: Record<string, unknown>
}

export interface AlertSink {
  raise(alert: Alert): Promise<void>
}

/** Writes through `raise_alert`, which bumps an open alert rather than duplicating it. */
export class PgAlertSink implements AlertSink {
  constructor(private readonly db: Pool, private readonly logger: Logger) {}

  async raise(alert: Alert): Promise<void> {
    try {
      await this.db.query(
        `select raise_alert($1, $2, $3, $4, $5::jsonb)`,
        [
          alert.kind,
          alert.message,
          alert.severity ?? 'error',
          alert.campaignId ?? null,
          JSON.stringify(alert.detail ?? {}),
        ],
      )
    } catch (err) {
      // Never let alerting failure take down the work it is reporting on. Log
      // loudly instead — this is the last line before silence.
      this.logger.error('could not raise alert', err, { kind: alert.kind })
    }
    this.logger.warn(`ALERT ${alert.kind}: ${alert.message}`, alert.detail)
  }
}

/** For tests and for the paths that have no database handle. */
export class MemoryAlertSink implements AlertSink {
  readonly raised: Alert[] = []
  async raise(alert: Alert): Promise<void> { this.raised.push(alert) }
  kinds(): string[] { return this.raised.map(a => a.kind) }
}

/** Used where alerting is genuinely not wanted, so the intent is explicit. */
export class NullAlertSink implements AlertSink {
  async raise(): Promise<void> { /* deliberately nothing */ }
}
