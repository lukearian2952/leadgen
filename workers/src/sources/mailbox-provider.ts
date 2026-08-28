// Mailbox providers: ask a service that already knows an address, rather than
// guessing one.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The largest single loss in the pipeline is not naming and not verification.
// **176 businesses — 12.5% of everything processed — are named and unmailable**,
// and of 209 Tier C rows, 205 have no `owner_email` at all rather than one that
// failed: 1 risky, 0 invalid. The person is known, the domain is known, and no
// candidate address was ever produced that verified.
//
// It is not the ladder's fault for being too short. `PATTERN_LADDER_EXTRAS`
// measured **zero recovery for 2.6× the verification spend**, which says the
// guessing approach is exhausted — not that the mailboxes do not exist.
//
// v1 had `provider.ts` (Hunter / Apollo) and v2 shipped without it. This is
// that component, rebuilt, and it is the last item on the build list.
//
// ── Where it sits ───────────────────────────────────────────────────────────
//
// **Last, and only for leads that failed.** `enrich:lead` runs the free sources
// and the pattern ladder first and verifies them in one batch; a provider
// lookup is bought only when that batch produced nothing deliverable. Asking
// upfront would spend a paid request on every lead the ladder was going to
// solve for free.
//
// ── What it does not do ─────────────────────────────────────────────────────
//
// **A provider address does not bypass the gate.** Hunter returns its own
// `verification.status` and its own confidence score, and neither is accepted
// in place of ours: the address is added to the candidate set and verified
// through Verifalia like any other. Hunter proposes, Verifalia disposes, and
// `email_status` keeps meaning exactly what it meant before — our verdict, not
// a vendor's.
//
// This matters because Hunter will return an address with `sources: 0`, meaning
// it inferred the address the same way our ladder does. Trusting its self-report
// would be trusting a guess with better branding.

import type { Logger } from '../logger.js'
import { httpFetch } from '../net.js'

export interface MailboxLookup {
  email: string
  /** Provider's own confidence, 0-100 for Hunter. Recorded, never gating. */
  score: number | null
  /** How many public pages the provider has actually seen this address on. */
  sources: number
  /** The provider's own verdict. Recorded for comparison, never gating. */
  providerStatus: string | null
}

export interface MailboxProvider {
  readonly name: string
  /** Cents per lookup, for source_costs. */
  readonly centsPerLookup: number
  find(
    domain: string, firstName: string, lastName: string,
  ): Promise<MailboxLookup | null>
}

export class HunterProvider implements MailboxProvider {
  readonly name = 'hunter'
  /** Starter plan: 2,000 searches/month at $34 — 1.7¢ each. */
  readonly centsPerLookup = 1.7

  constructor(private readonly apiKey: string, private readonly logger: Logger) {}

  async find(
    domain: string, firstName: string, lastName: string,
  ): Promise<MailboxLookup | null> {
    if (!domain || !firstName || !lastName) return null

    const url = new URL('https://api.hunter.io/v2/email-finder')
    url.searchParams.set('domain', domain)
    url.searchParams.set('first_name', firstName)
    url.searchParams.set('last_name', lastName)
    url.searchParams.set('api_key', this.apiKey)

    const res = await httpFetch(url, { signal: AbortSignal.timeout(20_000) })
    const text = await res.text()

    if (!res.ok) {
      // 429 is the monthly allowance, not a transient. Both are logged and
      // neither fails the lead: a provider outage means no provider address,
      // which is the state every lead was in before this existed.
      this.logger.warn('hunter lookup failed', {
        status: res.status, domain, body: text.slice(0, 160),
      })
      return null
    }

    const body = JSON.parse(text) as {
      data?: {
        email?: string | null
        score?: number | null
        sources?: unknown[]
        verification?: { status?: string | null } | null
      }
    }

    const email = (body.data?.email ?? '').trim().toLowerCase()
    if (!email) return null

    return {
      email,
      score: body.data?.score ?? null,
      sources: (body.data?.sources ?? []).length,
      providerStatus: body.data?.verification?.status ?? null,
    }
  }
}

/**
 * Pick a provider from config. Null when none is configured, which is the
 * state the pipeline ran in until now and must keep working in.
 */
export function makeMailboxProvider(
  cfg: { mailboxProvider: string; hunterApiKey: string },
  logger: Logger,
): MailboxProvider | null {
  const forced = (cfg.mailboxProvider ?? '').trim().toLowerCase()
  if (forced && forced !== 'hunter') {
    logger.warn('unknown MAILBOX_PROVIDER — no provider lookup will run', { forced })
    return null
  }
  if (!cfg.hunterApiKey) return null
  return new HunterProvider(cfg.hunterApiKey, logger)
}
