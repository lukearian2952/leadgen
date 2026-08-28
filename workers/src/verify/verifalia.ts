// Verifalia, behind the VerifierProvider interface.
//
// The polling logic is v1's `_shared/verifalia.ts` — it was correct and there
// is no reason to rewrite it. What changed is the shape it speaks: Verifalia's
// four classifications map onto our four statuses, and its per-entry `status`
// detail (ServerIsCatchAll, MailboxDoesNotExist, …) becomes `is_catch_all`.
//
// Its role is now the safety net, not the default. It is the only provider that
// costs money per check, so the hybrid router is careful about what reaches it.

import type { VerifierProvider, VerifyResult, VerifyStatus } from './types.js'
import { httpFetch } from '../net.js'
import type { Logger } from '../logger.js'
import { metrics } from '../metrics.js'
import {
  ALERT_VERIFALIA_AUTH, ALERT_VERIFALIA_PAYMENT, NullAlertSink, type AlertSink,
} from './alerts.js'

const VERIF_BASE = 'https://api.verifalia.com/v2.5'

/** List price per credit. Used for the per-campaign spend cap. */
export const VERIFALIA_COST_CENTS = 0.3

interface VerifaliaJob {
  overview?: { id?: string; status?: string }
  id?: string
  status?: string | { name?: string }
  entries?: { data?: Array<{ inputData: string; classification: string; status?: string }> }
}

function jobId(job: VerifaliaJob): string {
  return job.overview?.id ?? job.id ?? ''
}

function jobStatus(job: VerifaliaJob): string {
  const raw = job.overview?.status
    ?? (typeof job.status === 'string' ? job.status : job.status?.name)
    ?? ''
  return raw.toLowerCase()
}

function isDone(job: VerifaliaJob): boolean {
  const status = jobStatus(job)
  if (status === 'completed') return true
  return status === '' && !!job.entries?.data?.length
}

/**
 * Verifalia classification → our status.
 *
 * Note `Risky` covers both catch-all and low-quality-but-existing mailboxes.
 * v1's gate rejected all of them; we now keep the distinction, because a
 * catch-all Risky with a registry-confirmed name is exactly a Tier B lead.
 */
function mapClassification(classification: string): VerifyStatus {
  switch ((classification ?? '').toLowerCase()) {
    case 'deliverable':   return 'safe'
    case 'undeliverable': return 'invalid'
    case 'risky':         return 'risky'
    default:              return 'unknown'
  }
}

const CATCH_ALL_RE = /catch.?all/i
const ROLE_RE = /role/i

export class VerifaliaProvider implements VerifierProvider {
  readonly name = 'verifalia'

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly logger: Logger,
    private readonly maxWaitMs = 90_000,
    private readonly alerts: AlertSink = new NullAlertSink(),
    /** Set so alerts can name the run they broke. */
    private readonly campaignId: string | null = null,
    /**
     * API root. Overridable so the 402 path can be exercised against a stub.
     *
     * The 402 branch is the one that took out a whole run's verification, and
     * until now it could only be reached by actually running Verifalia out of
     * credits — which is to say it was reachable only by the accident it exists
     * to report. A provider whose failure path cannot be exercised on purpose
     * is a provider whose failure path is untested.
     */
    private readonly baseUrl: string = VERIF_BASE,
  ) {}

  async available(): Promise<boolean> {
    return Boolean(this.username && this.password)
  }

  private async raiseCredentialAlert(status: number, pending: number): Promise<void> {
    const payment = status === 402
    await this.alerts.raise({
      kind: payment ? ALERT_VERIFALIA_PAYMENT : ALERT_VERIFALIA_AUTH,
      severity: 'error',
      campaignId: this.campaignId,
      message: payment
        ? 'Verifalia is out of credits (HTTP 402). Verification has no fallback — ' +
          'addresses will stay unverified and cannot reach Tier A until it is topped up.'
        : 'Verifalia rejected our credentials (HTTP 401). Verification has no fallback ' +
          'until VERIFALIA_USERNAME / VERIFALIA_PASSWORD are corrected.',
      detail: { http_status: status, addresses_pending: pending },
    })
  }

  async verify(emails: string[]): Promise<VerifyResult[]> {
    const deduped = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
    if (!deduped.length) return []
    if (!await this.available()) {
      this.logger.warn('Verifalia credentials not set — returning unknown', { count: deduped.length })
      return deduped.map(e => unknown(e, 'no credentials'))
    }

    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64')
    const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
    const deadline = Date.now() + this.maxWaitMs
    const started = Date.now()

    const found = new Map<string, { classification: string; status: string }>()
    const CHUNK = 200

    for (let i = 0; i < deduped.length; i += CHUNK) {
      const chunk = deduped.slice(i, i + CHUNK)
      try {
        const submitRes = await httpFetch(`${this.baseUrl}/email-validations?waitTime=30000`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ entries: chunk.map(e => ({ inputData: e })) }),
        })
        if (!submitRes.ok) {
          // 402 and 401 are not transient and not per-address: the safety net
          // is gone for the whole run. Previously this logged a warning and
          // continued, which is how an entire Phase 2 run completed with every
          // candidate `unknown` and no indication why.
          if (submitRes.status === 402 || submitRes.status === 401) {
            await this.raiseCredentialAlert(submitRes.status, chunk.length)
            return deduped.map(e => unavailable(e,
              submitRes.status === 402
                ? 'Verifalia out of credits (HTTP 402)'
                : 'Verifalia rejected our credentials (HTTP 401)'))
          }
          this.logger.warn('Verifalia submit failed', { status: submitRes.status })
          continue
        }

        let job = await submitRes.json() as VerifaliaJob

        while (!isDone(job)) {
          if (Date.now() > deadline) {
            this.logger.warn('Verifalia poll timed out', { pending: chunk.length })
            break
          }
          await new Promise(r => setTimeout(r, 3000))
          const id = jobId(job)
          if (!id) break

          const pollRes = await httpFetch(`${this.baseUrl}/email-validations/${id}?waitTime=15000`, { headers })
          if (!pollRes.ok) break
          job = await pollRes.json() as VerifaliaJob
        }

        for (const entry of job.entries?.data ?? []) {
          found.set(entry.inputData.toLowerCase(), {
            classification: entry.classification ?? 'Unknown',
            status: entry.status ?? '',
          })
        }
      } catch (err) {
        this.logger.error('Verifalia chunk failed', err)
      }
    }

    const elapsed = Date.now() - started

    return deduped.map(email => {
      const entry = found.get(email)
      if (!entry) return unknown(email, 'no verdict returned')

      const status = mapClassification(entry.classification)
      metrics.verifyChecks.inc({ provider: 'verifalia', status })

      return {
        email,
        status,
        is_catch_all:  CATCH_ALL_RE.test(entry.status),
        is_disposable: /disposable/i.test(entry.status),
        is_role:       ROLE_RE.test(entry.status),
        provider:      this.name,
        latency_ms:    elapsed,
        cost_cents:    VERIFALIA_COST_CENTS,
        detail:        entry.status,
      }
    })
  }
}

function unknown(email: string, detail: string): VerifyResult {
  metrics.verifyChecks.inc({ provider: 'verifalia', status: 'unknown' })
  return {
    email, status: 'unknown', is_catch_all: false, is_disposable: false,
    is_role: false, provider: 'verifalia', latency_ms: 0, cost_cents: 0, detail,
  }
}

/** Unknown because Verifalia itself could not run. Costs nothing. */
function unavailable(email: string, detail: string): VerifyResult {
  return { ...unknown(email, detail), unavailable: true }
}
