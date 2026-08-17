import { describe, it, expect } from 'vitest'
import { decideName, samePerson, corroborationsFor, type NameCandidate } from '../src/lib/name-decision.js'

const NO_SITE = { peopleNamedOnSite: 0, ownershipVoice: false }

const cand = (o: Partial<NameCandidate> & Pick<NameCandidate, 'source' | 'nameClass'>): NameCandidate => ({
  first: 'Jane', last: 'Smith', title: '', ...o,
})

describe('samePerson', () => {
  it('matches on last name plus first initial', () => {
    expect(samePerson(
      cand({ source: 'registry', nameClass: 'owner_grade', first: 'Uzma', last: 'Iqbal' }),
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'U', last: 'Iqbal' }),
    )).toBe(true)
  })

  it('does not match two people who merely share a surname', () => {
    expect(samePerson(
      cand({ source: 'registry', nameClass: 'owner_grade', first: 'Uzma', last: 'Iqbal' }),
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Ahmed', last: 'Iqbal' }),
    )).toBe(false)
  })

  it('does not match on first name alone', () => {
    expect(samePerson(
      cand({ source: 'registry', nameClass: 'owner_grade', first: 'Jane', last: 'Smith' }),
      cand({ source: 'serp', nameClass: 'owner_grade', first: 'Jane', last: 'Doe' }),
    )).toBe(false)
  })
})

describe('decideName — usability comes before precedence', () => {
  it('takes an owner-grade site name over an uncorroborated clinical registry name', () => {
    const out = decideName([
      cand({ source: 'registry', nameClass: 'clinical_lead', first: 'Ann', last: 'Nguyen' }),
      cand({ source: 'site_crawl', nameClass: 'owner_grade', first: 'Bob', last: 'Ray', title: 'Owner' }),
    ], NO_SITE)
    expect(out.chosen?.first).toBe('Bob')
    expect(out.chosen?.source).toBe('site_crawl')
  })

  it('prefers registry over site when both are usable', () => {
    const out = decideName([
      cand({ source: 'site_crawl', nameClass: 'owner_grade', first: 'Bob', last: 'Ray' }),
      cand({ source: 'registry', nameClass: 'owner_grade', first: 'Ann', last: 'Nguyen' }),
    ], NO_SITE)
    expect(out.chosen?.source).toBe('registry')
  })

  it('prefers site over SERP', () => {
    const out = decideName([
      cand({ source: 'serp', nameClass: 'owner_grade', first: 'Cy', last: 'Lee' }),
      cand({ source: 'site_crawl', nameClass: 'owner_grade', first: 'Bob', last: 'Ray' }),
    ], NO_SITE)
    expect(out.chosen?.source).toBe('site_crawl')
  })
})

describe('decideName — clinical promotion', () => {
  it('rejects a clinical lead with no corroboration', () => {
    const out = decideName([
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Joseph', last: 'Pham',
             title: 'board-certified Nurse Practitioner' }),
    ], NO_SITE)
    expect(out.chosen).toBeNull()
    expect(out.reason).toBe('clinical_lead_uncorroborated')
  })

  it('promotes on a registry officer match', () => {
    const out = decideName([
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Joseph', last: 'Pham',
             title: 'board-certified NP' }),
      cand({ source: 'registry', nameClass: 'owner_grade', first: 'Joseph', last: 'Pham' }),
    ], NO_SITE)
    expect(out.chosen?.first).toBe('Joseph')
    // Registry wins on precedence and is owner-grade in its own right.
    expect(out.chosen?.source).toBe('registry')
    expect(out.considered.find(c => c.source === 'site_crawl')?.corroboration)
      .toContain('registry_officer')
  })

  it('promotes on a SERP owner hit', () => {
    const out = decideName([
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Cortney', last: 'Kucker',
             title: 'PA' }),
      cand({ source: 'serp', nameClass: 'owner_grade', first: 'Cortney', last: 'Kucker',
             title: 'Owner' }),
    ], NO_SITE)
    expect(out.chosen?.source).toBe('site_crawl')
    expect(out.chosen?.nameClass).toBe('clinical_lead')
    expect(out.promoted).toBe(true)
    expect(out.corroboration).toContain('serp_owner')
  })

  it('does NOT promote on a SERP hit that merely repeats the clinical title', () => {
    const out = decideName([
      cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Cortney', last: 'Kucker' }),
      cand({ source: 'serp', nameClass: 'clinical_lead', first: 'Cortney', last: 'Kucker' }),
    ], NO_SITE)
    expect(out.chosen).toBeNull()
  })

  it('promotes on sole-person-plus-ownership-voice', () => {
    const out = decideName(
      [cand({ source: 'site_crawl', nameClass: 'clinical_lead', first: 'Tatiana', last: 'Masone' })],
      { peopleNamedOnSite: 1, ownershipVoice: true },
    )
    expect(out.chosen?.first).toBe('Tatiana')
    expect(out.corroboration).toEqual(['sole_person_ownership'])
    expect(out.promoted).toBe(true)
  })

  it('does not apply sole-person to a name the site never mentioned', () => {
    const out = decideName(
      [cand({ source: 'serp', nameClass: 'clinical_lead', first: 'Tatiana', last: 'Masone' })],
      { peopleNamedOnSite: 1, ownershipVoice: true },
    )
    expect(out.chosen).toBeNull()
  })
})

describe('decideName — a source cannot corroborate itself', () => {
  it('ignores two registry columns naming the same person', () => {
    const all = [
      cand({ source: 'registry', nameClass: 'clinical_lead', first: 'Ann', last: 'Nguyen' }),
      cand({ source: 'registry', nameClass: 'clinical_lead', first: 'Ann', last: 'Nguyen' }),
    ]
    expect(corroborationsFor(all[0], all, NO_SITE)).toEqual([])
  })
})

describe('decideName — nothing at all', () => {
  it('reports no_owner_first_name with no candidates', () => {
    expect(decideName([], NO_SITE).reason).toBe('no_owner_first_name')
  })

  it('reports no_owner_grade_name when only staff was found', () => {
    const out = decideName([cand({ source: 'site_crawl', nameClass: 'staff' })], NO_SITE)
    expect(out.reason).toBe('no_owner_grade_name')
  })
})
