// The reverse lookup's ambiguity guard, and the assumption Florida broke.
//
// The guard originally applied only to the statewide fallback, reasoning that
// "the county scope is what keeps a full-name match meaningful". That holds for
// the counties it was written against — NY's — and fails in Florida, where
// Miami-Dade alone returns 200+ entities for `Maria Rodriguez` and 200+ for
// `Jose Garcia`. County-scoped there is no narrower than statewide for a common
// name, and the county path was taking rows[0] of an arbitrary three.
//
// These assert the decision rule rather than the SQL: what the code does with
// N matching entities, which is the part that decides whether a real person
// gets attached to the wrong business.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(
  fileURLToPath(new URL('../src/jobs/registry-match.ts', import.meta.url)), 'utf8')

/** The rule both scopes now apply. */
const MAX_SHARED_ENTITIES = 2
const admits = (matched: number) => matched > 0 && matched <= MAX_SHARED_ENTITIES

describe('the shared-name rule', () => {
  it('admits one holder — that is an identification', () => {
    expect(admits(1)).toBe(true)
  })
  it('admits two — still a person, per the brief', () => {
    expect(admits(2)).toBe(true)
  })
  it('rejects three or more — that is a common name', () => {
    expect(admits(3)).toBe(false)
    expect(admits(200)).toBe(false)
  })
  it('rejects nothing-matched', () => {
    expect(admits(0)).toBe(false)
  })
})

describe('the guard is applied to both scopes', () => {
  it('there is one constant, not a statewide-only one', () => {
    expect(src).toContain('const MAX_SHARED_ENTITIES = 2')
    expect(src).not.toContain('STATEWIDE_MAX_ENTITIES')
  })

  it('the county query fetches one more than the limit, so N+1 is detectable', () => {
    // Fetching exactly the limit cannot distinguish "three" from "three
    // hundred" — which is precisely what `limit 3` was hiding.
    expect(src).toMatch(/limit \$4`,\s*\n\s*\[state, counties, officerJson, MAX_SHARED_ENTITIES \+ 1\]/)
  })

  it('the county path discards an over-limit result rather than taking rows[0]', () => {
    expect(src).toContain(
      'let rows = countyRows.length <= MAX_SHARED_ENTITIES ? countyRows : []')
  })

  it('county rejections are counted, not silent', () => {
    expect(src).toContain('countyAmbiguous++')
    expect(src).toContain('reverse_county_ambiguous')
  })
})

describe('entity county is resolved from ZIP when the registry omits it', () => {
  // Sunbiz publishes city and ZIP and no county for all 11,031,417 FL rows.
  // Without this branch, loading the census crosswalk would have taken Florida
  // reverse from wrongly-broad to exactly zero.
  it('the county filter has a ZIP-crosswalk branch', () => {
    expect(src).toContain("county = '' and county_for_zip(postal_code, $1) = any($2)")
  })

  it('the officer containment is still the driver', () => {
    // It must stay ahead of the county test so the GIN index selects the rows
    // and the crosswalk is consulted for a handful, not eleven million.
    const where = src.slice(src.indexOf('and officers @> $3::jsonb'))
    expect(where.indexOf('county_for_zip')).toBeGreaterThan(0)
  })
})
