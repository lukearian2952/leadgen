// Tier derivation, kept free of React and Supabase so it can be tested.
//
// The frontend has no test runner of its own — `npm install` is not available
// in the environment this was written in — so these functions are exercised by
// the workers' vitest suite (`workers/test/frontend-tiers.test.ts`). That is the
// reason this file imports nothing but types: anything touching React or the
// Supabase client would drag a browser environment into a Node test run.

import type { Lead, Tier } from './types'

/**
 * A lead's tier, falling back to v1's boolean.
 *
 * Rows written before tiers existed carry only `gate_passed`, and nothing has
 * backfilled them — there are 3,615 leads in the table and the older campaigns
 * predate the four-way verdict entirely. Reading `gate_passed` as A/rejected is
 * exactly what it meant at the time, so the fallback is faithful rather than a
 * guess.
 *
 * `??` and not `||`: an empty-string tier is bad data and should not silently
 * become 'A' via the boolean, but a *null* tier is the ordinary v1 case.
 */
export function tierOf(lead: Pick<Lead, 'tier' | 'gate_passed'>): Tier {
  if (lead.tier) return lead.tier
  return lead.gate_passed ? 'A' : 'rejected'
}

export interface TierCounts {
  A: number
  B: number
  C: number
  rejected: number
}

/**
 * Count the four tiers across a set of leads.
 *
 * Derived from the rows rather than read from `campaigns.stat_*`, because those
 * counters are written by `finalize` at the end of a run: they are stale for a
 * campaign still in flight and absent for one that finished before tiers
 * existed. The leads are already in memory, so counting them is free and always
 * current.
 */
export function countTiers(leads: Array<Pick<Lead, 'tier' | 'gate_passed'>>): TierCounts {
  const counts: TierCounts = { A: 0, B: 0, C: 0, rejected: 0 }
  for (const lead of leads) {
    const tier = tierOf(lead)
    // A tier the UI does not know about must not be counted as anything. It is
    // better for a total to be short than for an unknown verdict to be
    // silently reported as sendable.
    if (tier in counts) counts[tier]++
  }
  return counts
}

/** Tiers that may be exported for sending. */
export const SENDABLE: readonly Tier[] = ['A', 'B']

export function isSendable(lead: Pick<Lead, 'tier' | 'gate_passed'>): boolean {
  return SENDABLE.includes(tierOf(lead))
}

/**
 * Sendable share of everything discovered.
 *
 * The denominator is **discovered**, not "leads with a verdict". A campaign that
 * discovered 1,000 businesses and reached a verdict on 100 of them has a 12%
 * sendable rate if 12 are sendable, not 12%-of-100. Using the smaller
 * denominator is how a 468-row export once read as a success.
 */
export function sendableRate(counts: TierCounts, discovered: number): number {
  if (discovered <= 0) return 0
  return ((counts.A + counts.B) / discovered) * 100
}

/**
 * Below this share of sendable leads, a finished campaign is `completed_low_yield`.
 *
 * A terminal *success* state: the run worked and the niche did not.
 */
export const LOW_YIELD_THRESHOLD_PCT = 25

export function isLowYield(counts: TierCounts, discovered: number): boolean {
  return discovered > 0 && sendableRate(counts, discovered) < LOW_YIELD_THRESHOLD_PCT
}
