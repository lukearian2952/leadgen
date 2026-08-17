// Learn a domain's email convention from addresses it already publishes,
// before guessing any.
//
// ── Why this is the highest-value thing in Phase 4 ───────────────────────────
//
// Phase 3 named 30 of 75 leads and converted 1 to Tier A. Six of the 30 ended
// `mailbox_invalid` — every generated candidate rejected — and six more died on
// catch-all domains where probing cannot distinguish a real mailbox from a
// guess. Both are the same underlying problem: we were *guessing* shapes rather
// than *knowing* them, and `domain_patterns` was nearly empty because it only
// ever learned from a successful verified send. That is circular — a domain has
// to convert before it can teach anything.
//
// This breaks the circle. A site that prints `sarah.kandhorov@novamedspa.com`
// on its contact page has told us the domain's pattern is `first.last`, for
// free, before a single probe. The person does not even have to be the owner:
// any staff member's address on the domain teaches the same convention.
//
// Sources, cheapest first: the crawl we already ran, `mailto:` links we already
// scraped, the Google listing we already have, and one SERP query. Only the
// last costs anything.

import { inferPattern, type PatternName } from './patterns.js'
import { isGenericLocalPart, isFreemail, emailDomain, isValidEmail } from './identity.js'

export type PatternSource = 'verified_send' | 'site_crawl' | 'mailto' | 'gbp' | 'serp'

export interface KnownPerson {
  first: string
  last: string
}

export interface DiscoveryInput {
  domain: string
  /** Addresses seen on this domain, with where each came from. */
  addresses: Array<{ email: string; source: PatternSource }>
  /** Everyone the crawl named on the site — any title, any class. */
  people: readonly KnownPerson[]
}

export interface DiscoveredPattern {
  pattern: PatternName
  source: PatternSource
  /** The address the pattern was read off. */
  learnedFrom: string
  /** Which named person it matched. */
  matchedPerson: string
}

export interface DiscoveryResult {
  /** Null when nothing on the domain could be tied to a known person. */
  discovered: DiscoveredPattern | null
  /** Every on-domain personal address found, for the evidence trail. */
  personalAddresses: string[]
  /** Every on-domain address found at all, including role inboxes. */
  onDomainAddresses: string[]
}

/**
 * Keep only addresses actually on this domain.
 *
 * A Wix support address in a template, the web designer's gmail in the footer,
 * and `sentry@` in a script tag are all on the page and none of them teach this
 * domain anything.
 */
function onDomain(email: string, domain: string): boolean {
  if (!isValidEmail(email)) return false
  const d = emailDomain(email)
  if (!d || isFreemail(d)) return false
  const root = domain.split('.').slice(-2).join('.')
  return d === domain || d === root || d.endsWith(`.${root}`)
}

/**
 * Infer the domain's pattern from any published address that belongs to a
 * person we can name.
 *
 * The pairing is what makes it sound: `sarah.kandhorov@` alone is a string, but
 * `sarah.kandhorov@` *and* a page naming "Sarah Kandhorov" is a demonstrated
 * `first.last` convention. Role inboxes are excluded — `info@` matches no
 * pattern and `booking@` would spuriously match `first` for anyone called
 * Booking.
 *
 * Source precedence follows how much the address is worth: an address on the
 * business's own site beats one from a search result.
 */
const SOURCE_RANK: Record<PatternSource, number> = {
  verified_send: 0, site_crawl: 1, mailto: 2, gbp: 3, serp: 4,
}

export function discoverPattern(input: DiscoveryInput): DiscoveryResult {
  const { domain, people } = input

  const seen = new Set<string>()
  const kept: Array<{ email: string; source: PatternSource }> = []
  for (const entry of input.addresses) {
    const email = (entry.email ?? '').toLowerCase().trim()
    if (!email || seen.has(email) || !onDomain(email, domain)) continue
    seen.add(email)
    kept.push({ email, source: entry.source })
  }

  const onDomainAddresses = kept.map(k => k.email)
  const personal = kept.filter(k => !isGenericLocalPart(k.email))
  const personalAddresses = personal.map(p => p.email)

  // Best source first, so a site address outranks a SERP one.
  personal.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])

  for (const entry of personal) {
    for (const person of people) {
      if (!person.first) continue
      const pattern = inferPattern(entry.email, person.first, person.last)
      if (!pattern) continue
      return {
        discovered: {
          pattern,
          source: entry.source,
          learnedFrom: entry.email,
          matchedPerson: [person.first, person.last].filter(Boolean).join(' '),
        },
        personalAddresses,
        onDomainAddresses,
      }
    }
  }

  return { discovered: null, personalAddresses, onDomainAddresses }
}

/**
 * Does this domain demonstrably receive mail?
 *
 * The precondition for the `catch_all_named` Tier-B rule. A catch-all domain
 * answers `RCPT TO` for anything, so probing proves nothing about a specific
 * mailbox — but a *published* address on that domain is the business telling
 * the world "mail sent here reaches us". That is a different and better kind of
 * evidence than an SMTP handshake, and it is the one thing separating a
 * catch-all domain that is a real business from a parked one.
 *
 * A role inbox counts. `info@theclinic.com` printed on the contact page proves
 * theclinic.com receives mail; it just does not reach the owner, which is why
 * it can never be the *chosen* address.
 */
export function domainHasPublishedMailbox(result: DiscoveryResult): boolean {
  return result.onDomainAddresses.length > 0
}

/** The SERP query for finding more addresses on a domain. */
export function addressQuery(domain: string): string {
  return `"@${domain}"`
}

/** Pull addresses out of SERP titles and snippets. */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

export function addressesFromText(text: string, domain: string): string[] {
  const out = new Set<string>()
  for (const m of (text ?? '').matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase()
    if (onDomain(email, domain)) out.add(email)
  }
  return [...out]
}
