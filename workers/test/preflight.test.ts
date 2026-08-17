import { describe, it, expect } from 'vitest'
import {
  predictTierA, estimateCost, censusRate, SEED_CALIBRATION,
  POOR_MAX, MODERATE_MAX, type CensusResult,
} from '../src/lib/preflight.js'

const census = (o: Partial<CensusResult>): CensusResult => ({
  businessesFound: 20, businessesWithSite: 18, addressesSeen: 30,
  onDomainAddresses: 6, onDomainPersonal: 2, businessesWithPersonal: 2, named: 8, ...o,
})

describe('censusRate', () => {
  it('is businesses-with-a-personal-address over businesses found', () => {
    expect(censusRate(census({ businessesFound: 20, businessesWithPersonal: 3 }))).toBe(15)
  })

  it('is 0, not NaN, when nothing was found', () => {
    expect(censusRate(census({ businessesFound: 0, businessesWithPersonal: 0 }))).toBe(0)
  })
})

describe('predictTierA — reproduces the three measured niches', () => {
  it('puts med spa (2.7%) in the poor band', () => {
    const p = predictTierA(2.667)
    expect(p.band).toBe('poor')
    // Observed 1.333; the band must contain it.
    expect(p.low).toBeLessThanOrEqual(1.333)
    expect(p.high).toBeGreaterThanOrEqual(1.333)
  })

  it('puts dental (15.2%) in the good band and contains its 6.3%', () => {
    const p = predictTierA(15.19)
    expect(p.band).toBe('good')
    expect(p.low).toBeLessThanOrEqual(6.329)
    expect(p.high).toBeGreaterThanOrEqual(6.329)
  })

  it('puts wrap (13.0%) in the good band and contains its 9.0%', () => {
    const p = predictTierA(13)
    expect(p.band).toBe('good')
    expect(p.low).toBeLessThanOrEqual(9)
    expect(p.high).toBeGreaterThanOrEqual(9)
  })

  it('warns explicitly in the unobserved middle', () => {
    const p = predictTierA((POOR_MAX + MODERATE_MAX) / 2)
    expect(p.band).toBe('moderate')
    expect(p.summary).toMatch(/no direct observation/i)
    // Widest band, since nothing was measured here.
    expect(p.high - p.low).toBeGreaterThan(predictTierA(13).high - predictTierA(13).low)
  })
})

describe('predictTierA — honesty about what it knows', () => {
  it('reports how many calibration points backed the answer', () => {
    expect(predictTierA(13).basedOn).toBe(SEED_CALIBRATION.length)
  })

  it('does not pretend to know anything with no calibration', () => {
    const p = predictTierA(13, [])
    expect(p.basedOn).toBe(0)
    expect(p.low).toBe(0)
    expect(p.high).toBe(100)
    expect(p.summary).toMatch(/no calibration/i)
  })

  it('sharpens as new points arrive', () => {
    // A fourth point at a higher rate should be able to move the upper edge.
    const withNew = predictTierA(20, [
      ...SEED_CALIBRATION,
      { niche: 'roofing', sampleSize: 200, onDomainPersonalRate: 22, tierARate: 18 },
    ])
    expect(withNew.high).toBeGreaterThan(predictTierA(20).high)
    expect(withNew.basedOn).toBe(4)
  })

  it('tells a poor-band caller to expect Tier B, not Tier A', () => {
    expect(predictTierA(1).summary).toMatch(/Tier B/)
  })
})

describe('estimateCost', () => {
  it('brackets the three measured per-business costs', () => {
    // $0.0129, $0.0136, $0.0167 observed.
    const { low, high } = estimateCost(1000)
    expect(low).toBeLessThanOrEqual(12.9)
    expect(high).toBeGreaterThanOrEqual(16.7)
  })

  it('is a range, not an average — a quote that is low half the time is worse', () => {
    const { low, high } = estimateCost(100)
    expect(high).toBeGreaterThan(low)
  })

  it('scales linearly', () => {
    expect(estimateCost(200).low).toBeCloseTo(estimateCost(100).low * 2, 2)
  })
})
