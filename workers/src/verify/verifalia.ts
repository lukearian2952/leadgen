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
  ) {}

  async available(): Promise<boolean> {
    return Boolean(this.username && this.password)
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
        const submitRes = await httpFetch(`${VERIF_BASE}/email-validations?waitTime=30000`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ entries: chunk.map(e => ({ inputData: e })) }),
        })
        if (!submitRes.ok) {
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

          const pollRes = await httpFetch(`${VERIF_BASE}/email-validations/${id}?waitTime=15000`, { headers })
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
