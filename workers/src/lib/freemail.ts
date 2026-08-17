// The Phase 3 freemail policy.
//
// ── What this recovers, and what it risks ────────────────────────────────────
//
// The Phase 2 run rejected 22 leads for `no_mx`. All 22 were re-checked against
// three resolvers with zero disagreement — they are web-only domains and site
// builders (glossgenius.com, square.site, hopp.bio, bookjune.com) that
// genuinely cannot receive mail. But 8 of the 22 publish a real, working Gmail
// on their own site:
//
//   coastalaestheticsny@   legacymedspa2@   skinmedspacontact@   myciaobellaspa@
//   endoaesthetics@        aestheticmedicallounge@               tatianalovestox@
//   contact.qualityaesthetics@
//
// v1's rule requires the *owner's name* in the local part, so only
// tatianalovestox@ (Tatiana Masone) survives it — 1 of 22. The rest are
// business-named, which is what a small business with no mail domain actually
// does.
//
// Loosening this is exactly the kind of change that produced v1's 6.4% bounce
// rate, so the new path is narrow on every axis at once. All four conditions:
//
//   1. **Published by the business itself** — scraped from its own site or its
//      Google listing. Never a generated guess. A guessed gmail address is
//      someone else's mailbox, and it will deliver.
//   2. **Verified `safe`** — not risky, not unknown, not catch-all.
//   3. **The local part contains a business-name token or the owner's name.**
//      "coastalaestheticsny" contains "coastal"; a bare "info@gmail.com" or a
//      staff member's personal address contains neither.
//   4. **A named person exists** to address the mail to.
//
// And the result is capped at **Tier B, never Tier A**, so it lands in the
// separately-labelled bucket rather than the main CSV.

import { emailDomain, isFreemail } from './identity.js'
import { normaliseName } from './normalise.js'

/** Label written to `tier_reason` when this path admits a row. */
export const FREEMAIL_TIER_REASON = 'freemail_business_verified'

const ASCII = (s: string) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase()

/**
 * Tokens from the business name distinctive enough that finding one in a
 * mailbox means the mailbox belongs to the business.
 *
 * Minimum four characters, and the niche words are excluded: "spa" or "med"
 * appearing in a local part says nothing, because it appears in every local
 * part in this niche. "coastal", "legacy", "ciao", "endo" are the ones that
 * carry information.
 */
const UNINFORMATIVE = new Set([
  'spa', 'med', 'medi', 'medical', 'medspa', 'the', 'and', 'inc', 'llc',
  'new', 'york', 'care', 'clinic', 'center', 'centre', 'studio', 'salon',
  'group', 'health', 'beauty', 'skin', 'laser', 'body', 'face', 'glow',
  'wellness', 'aesthetic', 'aesthetics', 'esthetics', 'cosmetic', 'cosmetics',
  'lounge', 'boutique',
])

export function businessNameTokens(businessName: string): string[] {
  return normaliseName(businessName)
    .split(' ')
    .map(t => ASCII(t))
    .filter(t => t.length >= 4 && !UNINFORMATIVE.has(t))
}

/**
 * The whole business name, flattened.
 *
 * Some businesses are named entirely out of niche words — "Aesthetic Medical
 * Lounge" has no distinctive token at all, and every individual word is
 * excluded above for good reason. But a local part containing the *entire*
 * name is a different and much stronger claim than one containing "spa":
 * `aestheticmedicallounge@gmail.com` is unambiguously that business.
 *
 * The 8-character floor stops this degenerating: "The Med Spa" flattens to
 * "medspa", which would match half the niche.
 */
const MIN_FULL_NAME_LENGTH = 8

export function flattenedBusinessName(businessName: string): string {
  const flat = ASCII(normaliseName(businessName).replace(/\s+/g, ''))
  return flat.length >= MIN_FULL_NAME_LENGTH ? flat : ''
}

export interface FreemailTierBInput {
  email: string
  businessName: string
  ownerFirst: string
  ownerLast: string
  /** Addresses actually scraped from the site or the Google listing. */
  publishedAddresses: readonly string[]
  /** The verifier's verdict for this address. */
  status: string
  isCatchAll: boolean
}

export interface FreemailTierBVerdict {
  accepted: boolean
  /** Which condition failed, for the reject reason. */
  reason: string
  /** Which token matched, for the evidence trail. */
  matchedToken?: string
}

export function freemailBusinessVerified(input: FreemailTierBInput): FreemailTierBVerdict {
  const email = (input.email ?? '').toLowerCase().trim()
  if (!isFreemail(emailDomain(email))) {
    return { accepted: false, reason: 'not_freemail' }
  }

  const published = new Set(input.publishedAddresses.map(e => e.toLowerCase().trim()))
  if (!published.has(email)) {
    return { accepted: false, reason: 'freemail_not_published' }
  }

  if (input.status !== 'safe' || input.isCatchAll) {
    return { accepted: false, reason: `freemail_not_safe:${input.status}` }
  }

  if (!input.ownerFirst) {
    return { accepted: false, reason: 'freemail_no_named_person' }
  }

  const local = ASCII(email.split('@')[0] ?? '')
  const first = ASCII(input.ownerFirst)
  const last = ASCII(input.ownerLast)

  if (first.length >= 3 && local.includes(first)) {
    return { accepted: true, reason: '', matchedToken: first }
  }
  if (last.length >= 4 && local.includes(last)) {
    return { accepted: true, reason: '', matchedToken: last }
  }
  for (const token of businessNameTokens(input.businessName)) {
    if (local.includes(token)) return { accepted: true, reason: '', matchedToken: token }
  }

  const whole = flattenedBusinessName(input.businessName)
  if (whole && local.includes(whole)) {
    return { accepted: true, reason: '', matchedToken: whole }
  }

  return { accepted: false, reason: 'freemail_local_part_unrelated' }
}
