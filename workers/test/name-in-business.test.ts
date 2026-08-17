import { describe, it, expect } from 'vitest'
import { nameInBusinessName } from '../src/lib/name-class.js'
import { decideName, type NameCandidate } from '../src/lib/name-decision.js'
import { adjacentCounties } from '../src/lib/counties.js'

describe('nameInBusinessName', () => {
  it('accepts first + last in the business name outright', () => {
    expect(nameInBusinessName('Bobbi', 'Balzo', 'Skin by Bobbi Balzo', false)).toBe(true)
    expect(nameInBusinessName('Tatiana', 'Masone', 'Tatiana Masone, NP Aesthetic Injector', false))
      .toBe(true)
  })

  it('accepts first-name-only WITH ownership voice', () => {
    // The Phase 3 miss this rule exists for.
    expect(nameInBusinessName('Tatiana', 'Rivera', 'Tatiana Loves Tox', true)).toBe(true)
    expect(nameInBusinessName('Debbie', 'Nguyen', "Dr. Debbie's Aesthetics", true)).toBe(true)
  })

  it('rejects first-name-only WITHOUT ownership voice', () => {
    expect(nameInBusinessName('Tatiana', 'Rivera', 'Tatiana Loves Tox', false)).toBe(false)
  })

  it('rejects a coincidental first-name match', () => {
    // An esthetician called Bella at "Ciao Bella" is not the owner, and
    // nobody called Sage runs "Sage Beauty Bar".
    expect(nameInBusinessName('Bella', 'Rossi', 'Ciao Bella Skin + Scalp', false)).toBe(false)
    expect(nameInBusinessName('Sage', 'Turner', 'Sage Beauty Bar + Spa', false)).toBe(false)
  })

  it('rejects a last-name-only match', () => {
    // "Sunflower Spa" run by a Ms. Sunflower is possible; a staff member
    // called Sunflower is likelier.
    expect(nameInBusinessName('Dan', 'Sunflower', 'Sunflower SPA', true)).toBe(false)
  })

  it('ignores two-character name tokens', () => {
    expect(nameInBusinessName('Al', 'Vo', 'Al Vo Med Spa', false)).toBe(false)
  })

  it('is case- and punctuation-insensitive', () => {
    expect(nameInBusinessName('bobbi', 'BALZO', 'SKIN BY BOBBI-BALZO!', false)).toBe(true)
  })
})

describe('decideName — name_in_business_name promotes a clinical lead', () => {
  const clinical = (o: Partial<NameCandidate> = {}): NameCandidate => ({
    source: 'site_crawl', first: 'Tatiana', last: 'Masone', title: 'NP',
    nameClass: 'clinical_lead', ...o,
  })

  it('promotes when the business is named after them', () => {
    const out = decideName([clinical()], {
      peopleNamedOnSite: 3, ownershipVoice: true,
      businessName: 'Tatiana Masone, NP Aesthetic Injector',
    })
    expect(out.chosen?.first).toBe('Tatiana')
    expect(out.promoted).toBe(true)
    expect(out.corroboration).toContain('name_in_business_name')
  })

  it('does not promote when the name is absent from the business name', () => {
    const out = decideName([clinical()], {
      peopleNamedOnSite: 3, ownershipVoice: true, businessName: 'Coastal Aesthetics',
    })
    expect(out.chosen).toBeNull()
    expect(out.reason).toBe('clinical_lead_uncorroborated')
  })

  it('applies to a registry candidate too, not just a site one', () => {
    const out = decideName(
      [clinical({ source: 'registry' })],
      { peopleNamedOnSite: 0, ownershipVoice: false, businessName: 'Masone Aesthetics Tatiana' },
    )
    expect(out.corroboration).toContain('name_in_business_name')
  })

  it('is inert when no business name is supplied', () => {
    const out = decideName([clinical()], { peopleNamedOnSite: 3, ownershipVoice: true })
    expect(out.chosen).toBeNull()
  })
})

describe('decideName — reverse registry corroboration is reported separately', () => {
  it('labels a reverse hit registry_officer_reverse', () => {
    const out = decideName([
      { source: 'site_crawl', first: 'Cortney', last: 'Kucker', title: 'PA',
        nameClass: 'clinical_lead' },
      { source: 'registry', first: 'Cortney', last: 'Kucker', title: 'Officer',
        nameClass: 'owner_grade', detail: { reverse: true } },
    ], { peopleNamedOnSite: 4, ownershipVoice: false })

    const site = out.considered.find(c => c.source === 'site_crawl')
    expect(site?.corroboration).toContain('registry_officer_reverse')
    expect(site?.corroboration).not.toContain('registry_officer')
    expect(site?.usable).toBe(true)
  })

  it('records the reverse hit on the registry candidate itself when it wins', () => {
    // Registry outranks site, so a reverse hit that agrees with the site wins
    // the row — and its own corroboration list must still say where it came
    // from. Phase 4 reported "0 leads named by reverse lookup" while the
    // reverse lookup was responsible for the run's only Tier A.
    const out = decideName([
      { source: 'site_crawl', first: 'Marchelle', last: 'Charles', title: 'Founder',
        nameClass: 'owner_grade' },
      { source: 'registry', first: 'Marchelle', last: 'Charles', title: 'Registered Agent',
        nameClass: 'owner_grade', detail: { reverse: true, entity_name: 'MARCHELLE CHARLES BEAUTY, LLC' } },
    ], { peopleNamedOnSite: 1, ownershipVoice: false })

    expect(out.chosen?.source).toBe('registry')
    expect(out.corroboration).toContain('registry_officer_reverse')
  })

  it('does not claim a reverse hit for a forward match', () => {
    const out = decideName([
      { source: 'registry', first: 'Kara', last: 'Morris', title: 'Process Agent',
        nameClass: 'owner_grade', detail: { entity_name: 'KARASMATIC DAY SPA INC.' } },
    ], { peopleNamedOnSite: 0, ownershipVoice: false })
    expect(out.corroboration).not.toContain('registry_officer_reverse')
  })

  it('labels a forward hit registry_officer', () => {
    const out = decideName([
      { source: 'site_crawl', first: 'Uzma', last: 'Iqbal', title: 'MD',
        nameClass: 'clinical_lead' },
      { source: 'registry', first: 'Uzma', last: 'Iqbal', title: 'CEO / Chairman',
        nameClass: 'owner_grade' },
    ], { peopleNamedOnSite: 2, ownershipVoice: false })

    const site = out.considered.find(c => c.source === 'site_crawl')
    expect(site?.corroboration).toContain('registry_officer')
  })
})

describe('adjacentCounties', () => {
  it('includes the county itself first', () => {
    expect(adjacentCounties('NY', 'Nassau')[0]).toBe('Nassau')
  })

  it('reaches the boroughs Long Island businesses actually file in', () => {
    // Brizel Med Spa, Garden City (Nassau) files as BRIZEL BEAUTY SPA INC. in Kings.
    expect(adjacentCounties('NY', 'Nassau')).toContain('Kings')
    expect(adjacentCounties('NY', 'Nassau')).toContain('Queens')
  })

  it('falls back to the county alone when unmapped', () => {
    expect(adjacentCounties('NY', 'Chautauqua')).toEqual(['Chautauqua'])
    expect(adjacentCounties('TX', 'Harris')).toEqual(['Harris'])
  })

  it('returns nothing for no county, so the caller can decide', () => {
    expect(adjacentCounties('NY', '')).toEqual([])
  })
})
