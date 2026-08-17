import { describe, it, expect } from 'vitest'
import { isLongIsland, longIslandCounty } from '../src/lib/long-island.js'

describe('Long Island membership', () => {
  it('recognises the towns the query list missed', () => {
    // These were scored as not-Long-Island by the ad-hoc 30-town check, which
    // is what made the first clean run report 57/75 instead of the true figure.
    for (const city of ['Westbury', 'Port Jefferson Station', 'Bethpage', 'Merrick']) {
      expect(isLongIsland(city), city).toBe(true)
    }
  })

  it('assigns the right county', () => {
    expect(longIslandCounty('Garden City')).toBe('Nassau')
    expect(longIslandCounty('Port Jefferson Station')).toBe('Suffolk')
    expect(longIslandCounty('Mineola')).toBe('Nassau')
    expect(longIslandCounty('Smithtown')).toBe('Suffolk')
  })

  it('tolerates the suffixes Google returns', () => {
    expect(isLongIsland('Massapequa, NY')).toBe(true)
    expect(isLongIsland('  mineola ny ')).toBe(true)
  })

  it('handles abbreviated place names', () => {
    // Google returns both forms for the same hamlet; only the abbreviated one
    // appeared in the run, and it was the sole reason 2 of 75 rows scored as
    // not-Long-Island.
    expect(longIslandCounty('Mt Sinai')).toBe('Suffolk')
    expect(longIslandCounty('Mount Sinai')).toBe('Suffolk')
    expect(longIslandCounty('St. James')).toBe('Suffolk')
  })

  it('rejects places that are not Long Island', () => {
    for (const city of ['Brooklyn', 'Queens', 'New York', 'Yonkers', 'Stamford', '']) {
      expect(isLongIsland(city), city).toBe(false)
    }
  })
})
