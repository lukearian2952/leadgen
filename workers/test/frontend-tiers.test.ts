// The frontend's tier logic.
//
// The React app has no test runner of its own — `npm install` was unavailable
// in the environment this was written in — so the pure half of its logic lives
// in `src/lib/tiers.ts` and is exercised here. That is a deliberate trade: the
// alternative was leaving the only code that decides *what a customer may send
// to* untested because of a package manager.
//
// What is covered is the part that would fail silently and expensively: reading
// a v1 row's boolean as a tier, and computing the sendable share against the
// right denominator.

import { describe, it, expect } from 'vitest'
import {
  tierOf, countTiers, isSendable, sendableRate, isLowYield,
  LOW_YIELD_THRESHOLD_PCT,
} from '../../src/lib/tiers.js'

type Row = { tier: 'A' | 'B' | 'C' | 'rejected' | null; gate_passed: boolean }
const row = (tier: Row['tier'], gate_passed = false): Row => ({ tier, gate_passed })

describe('tierOf', () => {
  it('uses the tier when there is one', () => {
    expect(tierOf(row('A'))).toBe('A')
    expect(tierOf(row('B'))).toBe('B')
    expect(tierOf(row('C'))).toBe('C')
    expect(tierOf(row('rejected'))).toBe('rejected')
  })

  it('reads a pre-tier row through its gate_passed boolean', () => {
    // 3,615 leads exist and the older campaigns predate the four-way verdict.
    // Nothing has backfilled them.
    expect(tierOf(row(null, true))).toBe('A')
    expect(tierOf(row(null, false))).toBe('rejected')
  })

  it('prefers the tier over the boolean when they disagree', () => {
    // finalize can demote a row that gate_passed once; the tier is the newer
    // and more specific verdict.
    expect(tierOf(row('C', true))).toBe('C')
    expect(tierOf(row('A', false))).toBe('A')
  })
})

describe('countTiers', () => {
  it('counts the four tiers', () => {
    expect(countTiers([
      row('A'), row('A'), row('B'), row('C'), row('rejected'), row('rejected'),
    ])).toEqual({ A: 2, B: 1, C: 1, rejected: 2 })
  })

  it('counts a mixed set of v1 and v2 rows', () => {
    expect(countTiers([row('A'), row(null, true), row(null, false), row('C')]))
      .toEqual({ A: 2, B: 0, C: 1, rejected: 1 })
  })

  it('returns zeros for an empty set rather than throwing', () => {
    expect(countTiers([])).toEqual({ A: 0, B: 0, C: 0, rejected: 0 })
  })

  it('ignores a tier it does not recognise instead of miscounting it', () => {
    // Better for a total to be short than for an unknown verdict to be
    // reported as sendable.
    const counts = countTiers([{ tier: 'D' as never, gate_passed: true }, row('A')])
    expect(counts).toEqual({ A: 1, B: 0, C: 0, rejected: 0 })
  })
})

describe('isSendable', () => {
  it('admits A and B and nothing else', () => {
    expect(isSendable(row('A'))).toBe(true)
    expect(isSendable(row('B'))).toBe(true)
    expect(isSendable(row('C'))).toBe(false)
    expect(isSendable(row('rejected'))).toBe(false)
  })

  it('treats a pre-tier gate_passed row as sendable', () => {
    expect(isSendable(row(null, true))).toBe(true)
  })
})

describe('sendableRate', () => {
  it('measures against everything discovered, not against rows with a verdict', () => {
    // A campaign that discovered 1,000 and judged 100 of them has a 1.2% rate,
    // not 12%. Using the smaller denominator is how a 468-row export once read
    // as a success.
    const counts = { A: 10, B: 2, C: 30, rejected: 58 }
    expect(sendableRate(counts, 1000)).toBeCloseTo(1.2)
    expect(sendableRate(counts, 100)).toBeCloseTo(12)
  })

  it('is zero rather than NaN when nothing was discovered', () => {
    expect(sendableRate({ A: 0, B: 0, C: 0, rejected: 0 }, 0)).toBe(0)
  })

  it('reproduces the two real runs', () => {
    // car wrap national: 70 A + 53 B of 1,042 discovered
    expect(sendableRate({ A: 70, B: 53, C: 59, rejected: 860 }, 1042)).toBeCloseTo(11.8, 1)
    // practice management SaaS: 1 A + 2 B of 149
    expect(sendableRate({ A: 1, B: 2, C: 49, rejected: 97 }, 149)).toBeCloseTo(2.0, 1)
  })
})

describe('isLowYield', () => {
  it('flags a run under the threshold', () => {
    expect(isLowYield({ A: 70, B: 53, C: 59, rejected: 860 }, 1042)).toBe(true)
  })

  it('does not flag a run at or above it', () => {
    expect(isLowYield({ A: 25, B: 0, C: 0, rejected: 75 }, 100)).toBe(false)
    expect(isLowYield({ A: 26, B: 0, C: 0, rejected: 74 }, 100)).toBe(false)
  })

  it('is exactly the documented threshold', () => {
    expect(LOW_YIELD_THRESHOLD_PCT).toBe(25)
    // 24.9% is low yield, 25% is not.
    expect(isLowYield({ A: 249, B: 0, C: 0, rejected: 751 }, 1000)).toBe(true)
    expect(isLowYield({ A: 250, B: 0, C: 0, rejected: 750 }, 1000)).toBe(false)
  })

  it('does not call an empty campaign low-yield', () => {
    // A campaign that has discovered nothing yet has not failed at anything.
    expect(isLowYield({ A: 0, B: 0, C: 0, rejected: 0 }, 0)).toBe(false)
  })
})
