// Client for verify-svc — our Go service wrapping AfterShip/email-verifier.
//
// verify-svc owns the parts that must not be duplicated per worker replica:
// per-MX throttling, IP rotation, cooldown. This client is therefore thin. It
// does not retry: a 503 from verify-svc means "all IPs are cooling", which is a
// routing signal for the hybrid layer, not a transient error to paper over.

import type { VerifierProvider, VerifyResult, VerifyStatus } from './types.js'
import { httpFetch } from '../net.js'
import type { Logger } from '../logger.js'
import { metrics } from '../metrics.js'
import { ALERT_VERIFIER_COOLING, NullAlertSink, type AlertSink } from './alerts.js'

interface SvcResult {
  email: string
  status: string
  is_catch_all: boolean
  is_disposable: boolean
  is_role: boolean
  latency_ms: number
  detail?: string
}

interface SvcResponse {
  results: SvcResult[]
  /** Set when the service could not check at all. */
  error?: string
  /** True when every configured IP is in cooldown. */
  all_cooling?: boolean
}

/** verify-svc is self-hosted: no per-check fee, only server time. */
const COST_CENTS_PER_CHECK = 0

const VALID: VerifyStatus[] = ['safe', 'invalid', 'risky', 'unknown']

function normaliseStatus(raw: string): VerifyStatus {
  const value = (raw ?? '').toLowerCase().trim()
  return (VALID as string[]).includes(value) ? value as VerifyStatus : 'unknown'
}

export class VerifySvcProvider implements VerifierProvider {
  readonly name = 'verify-svc'

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 180_000,
    private readonly alerts: AlertSink = new NullAlertSink(),
  ) {}

  async available(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const res = await httpFetch(new URL('/healthz', this.baseUrl), {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return false
      const body = await res.json() as { healthy?: boolean; active_ips?: number }
      // Healthy but with zero usable IPs is "not available" for our purposes —
      // the hybrid router needs to send this batch to Verifalia instead.
      return body.healthy === true && (body.active_ips ?? 0) > 0
    } catch {
      return false
    }
  }

  async verify(emails: string[]): Promise<VerifyResult[]> {
    const deduped = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
    if (!deduped.length) return []

    const started = Date.now()
    let body: SvcResponse

    try {
      const res = await httpFetch(new URL('/verify', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: deduped }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (res.status === 503) {
        // All IPs cooling. Flagged `unavailable` so the hybrid router reroutes
        // the entire batch rather than only the high-trust slice: this is a
        // fleet condition, not a set of inconclusive mailboxes.
        this.logger.warn('verify-svc reports all IPs cooling', { count: deduped.length })
        await this.alerts.raise({
          kind: ALERT_VERIFIER_COOLING,
          severity: 'warning',
          message: 'Every outbound verification IP is cooling; routing to the paid fallback.',
          detail: { addresses: deduped.length },
        })
        return deduped.map(email => unavailableResult(email, 'all verifier IPs cooling'))
      }

      if (!res.ok) {
        throw new Error(`verify-svc HTTP ${res.status}`)
      }

      body = await res.json() as SvcResponse
    } catch (err) {
      // A verifier failure must never be silently swallowed — that is exactly
      // what produced v1's 6.4% bounce rate. Unknown is the honest answer and
      // it cannot pass Tier A.
      this.logger.error('verify-svc call failed', err, { count: deduped.length })
      return deduped.map(email => unavailableResult(email, (err as Error).message))
    }

    const byEmail = new Map(body.results?.map(r => [r.email.toLowerCase(), r]) ?? [])
    const elapsed = Date.now() - started

    return deduped.map(email => {
      const hit = byEmail.get(email)
      if (!hit) return unknownResult(email, 'no verdict returned')

      const status = normaliseStatus(hit.status)
      metrics.verifyChecks.inc({ provider: 'verify-svc', status })

      return {
        email,
        status,
        is_catch_all:  Boolean(hit.is_catch_all),
        is_disposable: Boolean(hit.is_disposable),
        is_role:       Boolean(hit.is_role),
        provider:      this.name,
        latency_ms:    hit.latency_ms ?? elapsed,
        cost_cents:    COST_CENTS_PER_CHECK,
        detail:        hit.detail,
      }
    })
  }
}

function unknownResult(email: string, detail: string): VerifyResult {
  metrics.verifyChecks.inc({ provider: 'verify-svc', status: 'unknown' })
  return {
    email,
    status: 'unknown',
    is_catch_all: false,
    is_disposable: false,
    is_role: false,
    provider: 'verify-svc',
    latency_ms: 0,
    cost_cents: 0,
    detail,
  }
}

/** Unknown *because the provider could not run*, which reroutes the batch. */
function unavailableResult(email: string, detail: string): VerifyResult {
  return { ...unknownResult(email, detail), unavailable: true }
}
