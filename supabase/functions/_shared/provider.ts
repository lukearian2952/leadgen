// Owner-lookup stage (b): ask a data provider for a named contact on a domain.
//
// This replaces the rented Apollo actor, whose credentials were baked in and
// 401'd on every call. Both providers here run on OUR key, read from env. When
// no key is configured the stage skips and says so — it never silently
// pretends to have looked.

import { isValidEmail, isOwnerTitle } from './identity.ts'

export interface ProviderContact {
  firstName: string
  lastName: string
  title: string
  email: string
  /** Which provider produced it, for owner_source. */
  source: string
}

export interface ProviderOutcome {
  contact: ProviderContact | null
  /** null when a provider ran; a reason string when none is configured. */
  skipped: string | null
  error: string | null
}

const SKIPPED = (reason: string): ProviderOutcome =>
  ({ contact: null, skipped: reason, error: null })

/** Placeholder addresses providers return when the real mailbox is paywalled. */
function isLockedEmail(email: string): boolean {
  return /email_not_unlocked|not_unlocked|locked@|^email@/i.test(email)
}

function pickBest(candidates: ProviderContact[]): ProviderContact | null {
  const usable = candidates.filter(c => c.firstName)
  if (!usable.length) return null
  // Prefer an owner-titled contact, then anyone with a real mailbox.
  return usable.find(c => isOwnerTitle(c.title) && c.email)
    ?? usable.find(c => isOwnerTitle(c.title))
    ?? usable.find(c => c.email)
    ?? usable[0]
}

// ── Hunter.io ────────────────────────────────────────────────────────────────

interface HunterEmail {
  value?: string
  first_name?: string
  last_name?: string
  position?: string
  type?: string
}

async function hunterDomainSearch(domain: string, apiKey: string): Promise<ProviderOutcome> {
  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}` +
                `&limit=10&api_key=${encodeURIComponent(apiKey)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      return { contact: null, skipped: null, error: `Hunter HTTP ${res.status}` }
    }
    const json = await res.json() as { data?: { emails?: HunterEmail[] } }
    const candidates: ProviderContact[] = (json.data?.emails ?? [])
      .filter(e => e.type !== 'generic')
      .map(e => ({
        firstName: (e.first_name ?? '').trim(),
        lastName:  (e.last_name ?? '').trim(),
        title:     (e.position ?? '').trim(),
        email:     e.value && isValidEmail(e.value) && !isLockedEmail(e.value) ? e.value.trim() : '',
        source:    'hunter',
      }))
    return { contact: pickBest(candidates), skipped: null, error: null }
  } catch (err) {
    return { contact: null, skipped: null, error: `Hunter: ${(err as Error).message}` }
  }
}

// ── Apollo.io ────────────────────────────────────────────────────────────────

interface ApolloPerson {
  first_name?: string
  last_name?: string
  title?: string
  email?: string
}

async function apolloPeopleSearch(domain: string, apiKey: string): Promise<ProviderOutcome> {
  try {
    const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        page: 1,
        per_page: 10,
        person_titles: [
          'owner', 'founder', 'co-founder', 'ceo', 'president',
          'principal', 'managing director', 'practice owner',
          'medical director', 'clinic director',
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      return { contact: null, skipped: null, error: `Apollo HTTP ${res.status}` }
    }
    const json = await res.json() as { people?: ApolloPerson[] }
    const candidates: ProviderContact[] = (json.people ?? []).map(p => ({
      firstName: (p.first_name ?? '').trim(),
      lastName:  (p.last_name ?? '').trim(),
      title:     (p.title ?? '').trim(),
      email:     p.email && isValidEmail(p.email) && !isLockedEmail(p.email) ? p.email.trim() : '',
      source:    'apollo',
    }))
    return { contact: pickBest(candidates), skipped: null, error: null }
  } catch (err) {
    return { contact: null, skipped: null, error: `Apollo: ${(err as Error).message}` }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function providerConfigured(): string | null {
  if (Deno.env.get('HUNTER_API_KEY')) return 'hunter'
  if (Deno.env.get('APOLLO_API_KEY')) return 'apollo'
  return null
}

export async function lookupOwnerByDomain(domain: string): Promise<ProviderOutcome> {
  if (!domain) return SKIPPED('no domain')

  const hunterKey = Deno.env.get('HUNTER_API_KEY')
  if (hunterKey) return await hunterDomainSearch(domain, hunterKey)

  const apolloKey = Deno.env.get('APOLLO_API_KEY')
  if (apolloKey) return await apolloPeopleSearch(domain, apolloKey)

  return SKIPPED('no HUNTER_API_KEY or APOLLO_API_KEY configured')
}
