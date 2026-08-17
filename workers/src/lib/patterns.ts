// Email pattern inference.
//
// The difference between guessing and inferring. v1 generated six candidate
// shapes per lead and paid Verifalia to test all of them; on a catch-all domain
// that manufactures confident-looking garbage, and on a normal domain it is
// five wasted credits. Here, one verified address on a domain teaches the shape
// for every future lead on that domain, and the learned pattern is tried first.

import { extractDomain } from './identity.js'

export type PatternName =
  | 'first' | 'first.last' | 'flast' | 'firstl' | 'f.last' | 'first_last' | 'last'
  // Phase 4 extras. Tried only after the standard six, because they are
  // genuinely rarer — but 6 of 30 named Phase 3 leads died on
  // `mailbox_invalid`, which means the right shape was outside the six.
  | 'lastfirst' | 'first_l' | 'firstlast' | 'f_last'

/** Ordered by how common they are for small owner-operated businesses. */
export const PATTERN_ORDER: PatternName[] = [
  'first.last', 'first', 'flast', 'firstl', 'f.last', 'first_last', 'last',
]

/**
 * The Phase 4 extras. **Off by default** — set `PATTERN_LADDER_EXTRAS=true`.
 *
 * Measured on the 75-business benchmark and reverted: they recovered **zero**
 * mailboxes while taking average candidates per lead from 4.06 to 10.78,
 * Verifalia checks from 79 to 205, and enrichment spend from 23.7¢ to 61.5¢.
 * `mailbox_invalid` did not improve among leads named in both runs.
 *
 * Kept behind the flag rather than deleted because the negative result is
 * niche-specific: it says med spa owners do not use these shapes, not that
 * nobody does. A niche whose businesses run real corporate mail may well
 * justify turning it on — and then the measurement is one env var away.
 */
export const EXTRA_PATTERN_ORDER: PatternName[] = [
  'firstlast', 'lastfirst', 'first_l', 'f_last',
]

/** Everything, in the order candidates are generated. */
export const ALL_PATTERN_ORDER: PatternName[] = [...PATTERN_ORDER, ...EXTRA_PATTERN_ORDER]

/**
 * Shapes accepted for the `catch_all_named` Tier-B rule when the domain has no
 * learned pattern.
 *
 * A catch-all domain accepts everything, so the address cannot be confirmed by
 * probing it — the only protection is that the *shape* is one a human would
 * actually be given. `first@` and `first.last@` are the two that a small
 * business hands its owner; `flast@` and the rest are corporate conventions
 * that a two-person med spa does not have.
 */
export const CATCH_ALL_SAFE_PATTERNS: PatternName[] = ['first', 'first.last']

const ASCII = (s: string) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase()

export function renderPattern(
  pattern: PatternName, first: string, last: string, domain: string,
): string {
  const f = ASCII(first)
  const l = ASCII(last)
  if (!f || !domain) return ''
  // Every last-name-dependent shape is unusable without a last name; returning
  // '' rather than a truncated address keeps junk out of the candidate list.
  if (!l && pattern !== 'first') return ''

  switch (pattern) {
    case 'first':       return `${f}@${domain}`
    case 'first.last':  return `${f}.${l}@${domain}`
    case 'flast':       return `${f[0]}${l}@${domain}`
    case 'firstl':      return `${f}${l[0]}@${domain}`
    case 'f.last':      return `${f[0]}.${l}@${domain}`
    case 'first_last':  return `${f}_${l}@${domain}`
    case 'last':        return `${l}@${domain}`
    case 'firstlast':   return `${f}${l}@${domain}`
    case 'lastfirst':   return `${l}${f}@${domain}`
    case 'first_l':     return `${f}_${l[0]}@${domain}`
    case 'f_last':      return `${f[0]}_${l}@${domain}`
  }
}

/**
 * Which pattern does this known-good address follow?
 *
 * Returns null when the local part matches none of them — a personal mailbox
 * like `drjane@` or `smithdental@` teaches us nothing and must not be recorded
 * as a pattern, or it would poison every future candidate on that domain.
 */
export function inferPattern(email: string, first: string, last: string): PatternName | null {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const domain = (email.split('@')[1] ?? '').toLowerCase()
  if (!local || !domain) return null

  for (const pattern of ALL_PATTERN_ORDER) {
    const rendered = renderPattern(pattern, first, last, domain)
    if (rendered && rendered.split('@')[0] === local) return pattern
  }
  return null
}

/**
 * Candidate addresses for a named person on a domain.
 *
 * A known pattern collapses this to a single candidate, which is the entire
 * point: one SMTP probe instead of six, and no risk of a wrong-but-deliverable
 * guess landing first.
 */
export function candidatesFor(
  first: string, last: string, domain: string,
  knownPattern?: PatternName | null, max = 6,
): string[] {
  if (!first || !domain) return []

  if (knownPattern) {
    const only = renderPattern(knownPattern, first, last, domain)
    if (only) return [only]
    // The learned pattern needs a last name we do not have; fall through.
  }

  const out: string[] = []
  for (const pattern of PATTERN_ORDER) {
    const rendered = renderPattern(pattern, first, last, domain)
    if (rendered && !out.includes(rendered)) out.push(rendered)
    if (out.length >= max) break
  }
  return out
}

/**
 * The Phase 4 ladder: learned pattern, then the standard six, then the four
 * extras.
 *
 * Ordered, not scored, because verification stops at the first `safe`. Putting
 * the learned pattern first is what makes a domain with a known convention cost
 * one probe instead of ten; putting the extras last is what stops a rare shape
 * being tried before a common one on a domain we know nothing about.
 *
 * The extras exist because 6 of Phase 3's 30 named leads ended
 * `mailbox_invalid` — every candidate rejected — which means the real address
 * was a shape the six did not cover.
 */
export function candidateLadder(
  first: string, last: string, domain: string,
  knownPattern?: PatternName | null,
  includeExtras = false,
): string[] {
  if (!first || !domain) return []

  const out: string[] = []
  const push = (pattern: PatternName) => {
    const rendered = renderPattern(pattern, first, last, domain)
    if (rendered && !out.includes(rendered)) out.push(rendered)
  }

  if (knownPattern) push(knownPattern)
  for (const pattern of PATTERN_ORDER) push(pattern)
  if (includeExtras) for (const pattern of EXTRA_PATTERN_ORDER) push(pattern)
  return out
}

/**
 * Does this address follow a shape acceptable on a catch-all domain?
 *
 * Used by the `catch_all_named` rule. Either it matches the pattern the domain
 * is known to use, or it is one of the two shapes a small business actually
 * hands its owner. Anything else on a catch-all domain is a guess that will
 * verify `safe` whether or not the mailbox exists.
 */
export function followsAcceptedShape(
  email: string, first: string, last: string, knownPattern?: PatternName | null,
): { ok: boolean; pattern: PatternName | null } {
  const pattern = inferPattern(email, first, last)
  if (!pattern) return { ok: false, pattern: null }
  if (knownPattern && pattern === knownPattern) return { ok: true, pattern }
  return { ok: CATCH_ALL_SAFE_PATTERNS.includes(pattern), pattern }
}

/** A local part that cannot exist, for catch-all detection. */
export function catchAllProbe(domain: string): string {
  return `zz${Math.random().toString(36).slice(2, 10)}nx@${domain}`
}

export interface PatternRecord {
  domain: string
  pattern: PatternName
  confidence: number
  samples: number
}

/**
 * Fold a newly verified address into what we know about its domain.
 *
 * Agreement raises confidence; disagreement does not silently overwrite, it
 * drops confidence and only flips the stored pattern once the new shape has
 * out-voted the old one. Domains genuinely do run mixed conventions, and
 * thrashing between them is worse than holding the more-evidenced guess.
 */
export function foldPattern(
  existing: PatternRecord | null, email: string, first: string, last: string,
): PatternRecord | null {
  const pattern = inferPattern(email, first, last)
  if (!pattern) return existing

  const domain = extractDomain(email.split('@')[1] ?? '')
  if (!domain) return existing

  if (!existing) return { domain, pattern, confidence: 0.6, samples: 1 }

  if (existing.pattern === pattern) {
    return {
      domain,
      pattern,
      confidence: Math.min(0.99, existing.confidence + 0.15),
      samples: existing.samples + 1,
    }
  }

  const weakened = existing.confidence - 0.25
  if (weakened <= 0.35) {
    return { domain, pattern, confidence: 0.6, samples: 1 }
  }
  return { ...existing, domain, confidence: weakened }
}
