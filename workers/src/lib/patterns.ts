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

/** Ordered by how common they are for small owner-operated businesses. */
export const PATTERN_ORDER: PatternName[] = [
  'first.last', 'first', 'flast', 'firstl', 'f.last', 'first_last', 'last',
]

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

  for (const pattern of PATTERN_ORDER) {
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
