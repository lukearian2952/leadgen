import { describe, it, expect } from 'vitest'
import { freemailBusinessVerified, businessNameTokens, flattenedBusinessName } from '../src/lib/freemail.js'

const base = {
  businessName: 'Coastal Aesthetics',
  ownerFirst: 'Jane',
  ownerLast: 'Doe',
  status: 'safe',
  isCatchAll: false,
}

describe('freemailBusinessVerified — the four conditions', () => {
  it('accepts a published, business-named, verified gmail', () => {
    const out = freemailBusinessVerified({
      ...base,
      email: 'coastalaestheticsny@gmail.com',
      publishedAddresses: ['coastalaestheticsny@gmail.com'],
    })
    expect(out.accepted).toBe(true)
    expect(out.matchedToken).toBe('coastal')
  })

  it('rejects an address the business never published', () => {
    // The whole risk: a *generated* gmail guess is someone else's mailbox and
    // it will deliver.
    const out = freemailBusinessVerified({
      ...base,
      email: 'coastalaestheticsny@gmail.com',
      publishedAddresses: [],
    })
    expect(out).toMatchObject({ accepted: false, reason: 'freemail_not_published' })
  })

  it('rejects anything not verified safe', () => {
    for (const status of ['risky', 'unknown', 'invalid']) {
      expect(freemailBusinessVerified({
        ...base, status,
        email: 'coastalaestheticsny@gmail.com',
        publishedAddresses: ['coastalaestheticsny@gmail.com'],
      })).toMatchObject({ accepted: false })
    }
  })

  it('rejects when there is no named person to address', () => {
    expect(freemailBusinessVerified({
      ...base, ownerFirst: '', ownerLast: '',
      email: 'coastalaestheticsny@gmail.com',
      publishedAddresses: ['coastalaestheticsny@gmail.com'],
    })).toMatchObject({ accepted: false, reason: 'freemail_no_named_person' })
  })

  it('rejects a local part unrelated to the business or the owner', () => {
    expect(freemailBusinessVerified({
      ...base,
      email: 'sunshine1987@gmail.com',
      publishedAddresses: ['sunshine1987@gmail.com'],
    })).toMatchObject({ accepted: false, reason: 'freemail_local_part_unrelated' })
  })
})

// The eight real addresses the Phase 2 run rejected under no_mx, from the §6.1
// audit. Seven are business-named and one carries the owner's name.
describe('the eight addresses this rule exists to recover', () => {
  const cases: Array<[string, string]> = [
    ['coastalaestheticsny@gmail.com',    'Coastal Aesthetics'],
    ['legacymedspa2@gmail.com',          'Legacy MedSpa'],
    ['skinmedspacontact@gmail.com',      'Skin Med Spa'],
    ['myciaobellaspa@gmail.com',         'Ciao Bella Skin + Scalp'],
    ['endoaesthetics@gmail.com',         'Endo Aesthetics'],
    ['aestheticmedicallounge@gmail.com', 'Aesthetic Medical Lounge'],
    ['contact.qualityaesthetics@gmail.com', 'Quality Aesthetics'],
  ]

  it.each(cases)('%s is admissible for %s', (email, businessName) => {
    const out = freemailBusinessVerified({
      ...base, email, businessName, publishedAddresses: [email],
    })
    expect(out.accepted).toBe(true)
  })

  it('admits tatianalovestox@ on the owner name, as v1 already did', () => {
    const out = freemailBusinessVerified({
      ...base,
      email: 'tatianalovestox@gmail.com',
      businessName: 'Tatiana Aesthetics',
      ownerFirst: 'Tatiana', ownerLast: 'Masone',
      publishedAddresses: ['tatianalovestox@gmail.com'],
    })
    expect(out.accepted).toBe(true)
    expect(out.matchedToken).toBe('tatiana')
  })
})

describe('businessNameTokens', () => {
  it('drops the niche words that carry no information', () => {
    // "spa", "med", "aesthetics" appear in every name in this niche.
    expect(businessNameTokens('Coastal Aesthetics')).toEqual(['coastal'])
    expect(businessNameTokens('Legacy MedSpa')).toEqual(['legacy'])
    expect(businessNameTokens('Aesthetic Medical Lounge')).toEqual([])
  })

  it('falls back to nothing rather than to a generic token', () => {
    // With no distinctive token the rule must decline, not match on "spa".
    expect(businessNameTokens('The Med Spa')).toEqual([])
  })
})

describe('all-generic business names', () => {
  it('accepts a local part containing the WHOLE name', () => {
    // "Aesthetic Medical Lounge" has no distinctive token — every word is on
    // the stop list — but the entire flattened name in the local part is an
    // unambiguous claim, unlike any single word of it.
    expect(flattenedBusinessName('Aesthetic Medical Lounge')).toBe('aestheticmedicallounge')
    expect(freemailBusinessVerified({
      ...base,
      businessName: 'Aesthetic Medical Lounge',
      email: 'aestheticmedicallounge@gmail.com',
      publishedAddresses: ['aestheticmedicallounge@gmail.com'],
    })).toMatchObject({ accepted: true })
  })

  it('refuses the whole-name path when the name is too short to mean anything', () => {
    // "The Med Spa" flattens to "medspa", which would match half the niche.
    expect(flattenedBusinessName('The Med Spa')).toBe('')
    expect(freemailBusinessVerified({
      ...base,
      businessName: 'The Med Spa',
      email: 'medspa@gmail.com',
      publishedAddresses: ['medspa@gmail.com'],
    })).toMatchObject({ accepted: false, reason: 'freemail_local_part_unrelated' })
  })
})
