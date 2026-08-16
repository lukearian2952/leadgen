import { describe, it, expect } from 'vitest'
import { assignTier, scoreCandidate, TIER_B_MIN_SCORE } from '../src/verify/types.js'

const base = { hasName: true, hasDomain: true, isCatchAll: false, score: 0 }

describe('assignTier', () => {
  it('rejects anything with no name or no domain, whatever the verdict', () => {
    expect(assignTier({ ...base, status: 'safe', hasName: false })).toBe('rejected')
    expect(assignTier({ ...base, status: 'safe', hasDomain: false })).toBe('rejected')
  })

  it('gives Tier A only to a verified safe address on a non-catch-all domain', () => {
    expect(assignTier({ ...base, status: 'safe' })).toBe('A')
    // A "safe" verdict on a catch-all domain is meaningless — every address
    // returns safe there. This is the trap v1 rejected outright and the reason
    // Tier B exists instead.
    expect(assignTier({ ...base, status: 'safe', isCatchAll: true, score: 100 })).toBe('B')
  })

  it('gives Tier B to a well-corroborated catch-all candidate', () => {
    expect(assignTier({ ...base, status: 'unknown', isCatchAll: true, score: TIER_B_MIN_SCORE }))
      .toBe('B')
    expect(assignTier({ ...base, status: 'risky', isCatchAll: true, score: 80 })).toBe('B')
  })

  it('drops a catch-all candidate below the score threshold to Tier C', () => {
    expect(assignTier({ ...base, status: 'unknown', isCatchAll: true, score: TIER_B_MIN_SCORE - 1 }))
      .toBe('C')
  })

  it('puts everything else with a name in Tier C', () => {
    expect(assignTier({ ...base, status: 'unknown' })).toBe('C')
    expect(assignTier({ ...base, status: 'risky' })).toBe('C')
    expect(assignTier({ ...base, status: 'invalid' })).toBe('C')
  })
})

describe('scoreCandidate', () => {
  const none = {
    nameFromRegistryOrLinkedIn: false,
    nameFromSiteWithOwnerTitle: false,
    patternMatchesKnownDomainPattern: false,
    emailSeenOnSiteOrMailto: false,
    linkedInProfileLinksToDomain: false,
  }

  it('scores each signal at its documented weight', () => {
    expect(scoreCandidate({ ...none, nameFromRegistryOrLinkedIn: true })).toBe(40)
    expect(scoreCandidate({ ...none, nameFromSiteWithOwnerTitle: true })).toBe(25)
    expect(scoreCandidate({ ...none, patternMatchesKnownDomainPattern: true })).toBe(20)
    expect(scoreCandidate({ ...none, emailSeenOnSiteOrMailto: true })).toBe(10)
    expect(scoreCandidate({ ...none, linkedInProfileLinksToDomain: true })).toBe(10)
    expect(scoreCandidate(none)).toBe(0)
  })

  // The combination that must clear Tier B: a registry-confirmed officer whose
  // address matches a pattern already verified on that domain.
  it('clears the Tier B threshold for a registry name plus a known pattern', () => {
    const score = scoreCandidate({
      ...none, nameFromRegistryOrLinkedIn: true, patternMatchesKnownDomainPattern: true,
    })
    expect(score).toBe(60)
    expect(assignTier({ ...base, status: 'unknown', isCatchAll: true, score })).toBe('B')
  })

  // A site-scraped name alone is not enough — deliberately, because that is the
  // weakest source and the one v1 relied on exclusively.
  it('leaves a site-only name below the Tier B threshold', () => {
    const score = scoreCandidate({ ...none, nameFromSiteWithOwnerTitle: true })
    expect(score).toBeLessThan(TIER_B_MIN_SCORE)
    expect(assignTier({ ...base, status: 'unknown', isCatchAll: true, score })).toBe('C')
  })

  it('adds a site name plus pattern plus mailto to clear the threshold', () => {
    const score = scoreCandidate({
      ...none,
      nameFromSiteWithOwnerTitle: true,
      patternMatchesKnownDomainPattern: true,
      emailSeenOnSiteOrMailto: true,
    })
    expect(score).toBe(55)
    expect(assignTier({ ...base, status: 'unknown', isCatchAll: true, score })).toBe('B')
  })
})
