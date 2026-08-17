import { describe, it, expect } from 'vitest'
import { expandLocation, NATIONAL_CITIES } from '../src/lib/locations.js'
import { resolveNicheFilter, nicheQueryVariants } from '../src/lib/niche-types.js'
import { maxQueries, mapsWaitMs } from '../src/jobs/maps-discover.js'
import { staleLockMinutes, STALE_LOCK_FLOOR_MINUTES } from '../src/stale-locks.js'

describe('national expansion', () => {
  it('expands "United States" instead of searching for a city called that', () => {
    const cities = expandLocation('United States')
    expect(cities.length).toBeGreaterThan(150)
    expect(cities).not.toEqual(['United States'])
  })

  it.each(['usa', 'US', 'nationwide', 'America'])('accepts %s', alias => {
    expect(expandLocation(alias).length).toBeGreaterThan(150)
  })

  it('covers the country rather than one state', () => {
    // Ordered state by state, so a truncated run is still national.
    expect(NATIONAL_CITIES).toContain('Birmingham')   // AL, first
    expect(NATIONAL_CITIES).toContain('Anchorage')    // AK
    expect(NATIONAL_CITIES).toContain('Phoenix')      // AZ
    expect(NATIONAL_CITIES.indexOf('Anchorage'))
      .toBeGreaterThan(NATIONAL_CITIES.indexOf('Birmingham'))
  })

  it('has no duplicates', () => {
    expect(new Set(NATIONAL_CITIES).size).toBe(NATIONAL_CITIES.length)
  })

  it('does not let "united states" partial-match a state map key', () => {
    // 'us' would otherwise fall into the substring scan over STATE_MAP.
    expect(expandLocation('united states')).toEqual(NATIONAL_CITIES)
  })
})

describe('batch arithmetic for a 1,000-business run', () => {
  it('fits inside the query cap gosom handled cleanly', () => {
    const variants = nicheQueryVariants('car wrap')
    const perBatch = Math.floor(maxQueries({}) / variants.length)
    expect(variants.length).toBeGreaterThan(1)
    expect(perBatch * variants.length).toBeLessThanOrEqual(maxQueries({}))
  })

  it('needs more than one batch nationally', () => {
    const variants = nicheQueryVariants('car wrap')
    const perBatch = Math.floor(maxQueries({}) / variants.length)
    expect(Math.ceil(NATIONAL_CITIES.length / perBatch)).toBeGreaterThan(5)
  })

  it('scales the wait to the batch, not the campaign', () => {
    // Each batch is capped, so no batch ever asks for the 45-minute ceiling.
    expect(mapsWaitMs(maxQueries({}), {})).toBeLessThan(45 * 60_000)
  })
})

describe('per-niche SERP flag', () => {
  it('is off for the brick-and-mortar niches SERP failed on', () => {
    // 2 usable names across 254 businesses.
    for (const niche of ['med spa', 'dental practice', 'vehicle wrap shop']) {
      expect(resolveNicheFilter(niche).serp).toBe(false)
    }
  })

  it('is on for an unmatched niche, which is the online/SaaS case', () => {
    const f = resolveNicheFilter('practice management SaaS')
    expect(f.active).toBe(false)
    expect(f.serp).toBe(true)
  })
})

describe('stale lock threshold', () => {
  it('defaults above the longest possible job', () => {
    // maps:discover can legitimately hold a lock for 45 minutes.
    expect(staleLockMinutes({})).toBeGreaterThan(45)
  })

  it('refuses a threshold that would let a live job be stolen', () => {
    // Silently clamping would hide the fact that the operator asked for
    // something that causes double-running.
    expect(() => staleLockMinutes({ STALE_LOCK_MINUTES: '5' })).toThrow(/floor/)
    expect(() => staleLockMinutes({ STALE_LOCK_MINUTES: '30' })).toThrow(/double spend/)
  })

  it('accepts a value at or above the floor', () => {
    expect(staleLockMinutes({ STALE_LOCK_MINUTES: String(STALE_LOCK_FLOOR_MINUTES) }))
      .toBe(STALE_LOCK_FLOOR_MINUTES)
    expect(staleLockMinutes({ STALE_LOCK_MINUTES: '120' })).toBe(120)
  })

  it('ignores junk and falls back to the default', () => {
    expect(staleLockMinutes({ STALE_LOCK_MINUTES: 'soon' })).toBe(60)
    expect(staleLockMinutes({ STALE_LOCK_MINUTES: '-1' })).toBe(60)
  })
})
