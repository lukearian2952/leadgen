// Verifalia batch verification.
//
// Two changes from the old inline version in apify-webhook:
//
//  1. It returns the per-entry *status* alongside the classification, because
//     catch-all detection depends on it and pattern-guessing on a catch-all
//     domain is how you manufacture plausible-looking addresses that bounce.
//  2. A failure is reported to the caller instead of being swallowed. The old
//     code logged a warning and saved the address unverified, which is the
//     direct cause of the 6.4% bounce rate.

const VERIF_BASE = 'https://api.verifalia.com/v2.5'

/** Verifalia's four classifications, ordered best-first. */
export const CLASSIF_SCORE: Record<string, number> = {
  Deliverable: 0, Risky: 1, Unknown: 2, Undeliverable: 3,
}

export interface VerifiedEntry {
  classification: string
  /** Verifalia status detail, e.g. Success, ServerIsCatchAll, MailboxDoesNotExist. */
  status: string
}

export interface VerifyOutcome {
  results: Map<string, VerifiedEntry>
  /** True when at least one chunk did not resolve — callers must not trust gaps. */
  incomplete: boolean
  error: string | null
}

interface VerifaliaJob {
  overview?: { id?: string; status?: string }
  // Older shapes seen in the wild.
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
  // Some responses omit status entirely but ship the full entry set.
  return status === '' && !!job.entries?.data?.length
}

/**
 * Verify a set of addresses.
 *
 * @param maxWaitMs wall-clock budget for polling. Exceeding it returns
 *        `incomplete: true` rather than throwing, so the caller can park the
 *        affected rows as pending_verify for the watchdog to retry.
 */
export async function verifyEmails(
  emails: string[],
  user: string,
  pass: string,
  maxWaitMs = 90_000,
): Promise<VerifyOutcome> {
  const results = new Map<string, VerifiedEntry>()
  const deduped = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
  if (!deduped.length) return { results, incomplete: false, error: null }

  const auth = btoa(`${user}:${pass}`)
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
  const deadline = Date.now() + maxWaitMs

  // Verifalia caps entries per job; chunk defensively.
  const CHUNK = 200
  let incomplete = false
  let error: string | null = null

  for (let i = 0; i < deduped.length; i += CHUNK) {
    const chunk = deduped.slice(i, i + CHUNK)

    try {
      const submitRes = await fetch(`${VERIF_BASE}/email-validations?waitTime=30000`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ entries: chunk.map(e => ({ inputData: e })) }),
      })

      if (!submitRes.ok) {
        error = `Verifalia submit HTTP ${submitRes.status}`
        incomplete = true
        continue
      }

      let job = await submitRes.json() as VerifaliaJob

      while (!isDone(job)) {
        if (Date.now() > deadline) {
          incomplete = true
          error = error ?? 'Verifalia poll timed out'
          break
        }
        await new Promise(r => setTimeout(r, 3000))
        const id = jobId(job)
        if (!id) { incomplete = true; error = error ?? 'Verifalia job had no id'; break }

        const pollRes = await fetch(`${VERIF_BASE}/email-validations/${id}?waitTime=15000`, { headers })
        if (!pollRes.ok) {
          incomplete = true
          error = error ?? `Verifalia poll HTTP ${pollRes.status}`
          break
        }
        job = await pollRes.json() as VerifaliaJob
      }

      for (const entry of job.entries?.data ?? []) {
        results.set(entry.inputData.toLowerCase(), {
          classification: entry.classification ?? 'Unknown',
          status: entry.status ?? '',
        })
      }

      // A chunk that came back short means some addresses have no verdict.
      if (chunk.some(e => !results.has(e))) incomplete = true
    } catch (err) {
      incomplete = true
      error = error ?? (err as Error).message
    }
  }

  return { results, incomplete, error }
}

/**
 * A domain is catch-all when a guaranteed-nonexistent mailbox on it verifies as
 * anything other than Undeliverable. Guessing owner addresses on such a domain
 * produces confident-looking garbage, so the gate refuses to.
 */
export function probeSaysCatchAll(entry: VerifiedEntry | undefined): boolean {
  if (!entry) return true   // no verdict on the probe -> assume the worst
  if (/catch.?all/i.test(entry.status)) return true
  return entry.classification !== 'Undeliverable'
}

export function isCatchAllEntry(entry: VerifiedEntry | undefined): boolean {
  return !!entry && /catch.?all/i.test(entry.status)
}

/** The gate's email rule: exactly Deliverable, and never a catch-all verdict. */
export function isStrictlyDeliverable(entry: VerifiedEntry | undefined): boolean {
  if (!entry) return false
  if (isCatchAllEntry(entry)) return false
  return entry.classification === 'Deliverable'
}
