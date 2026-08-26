// The Oregon and Connecticut record shapes, asserted against records copied
// verbatim from the live APIs on 2026-08-26.
//
// Same reasoning as `fl-layout.test.ts`: an adapter is a bet about a published
// layout, and a wrong bet does not crash — it stores plausible garbage. Florida
// inverted every name until the fixed-width split was asserted against real
// bytes. These fixtures are the equivalent for the two shapes that are easy to
// get wrong here: Oregon's one-row-per-associated-name grouping, and
// Connecticut's principal/agent join.

import { describe, it, expect } from 'vitest'
import { toEntity as orEntity } from '../src/sources/registry/or.js'
import { toEntity as ctEntity } from '../src/sources/registry/ct.js'

// ── Oregon ───────────────────────────────────────────────────────────────────
//
// Verbatim from data.oregon.gov/resource/tckn-sxa6.json. One business is up to
// four rows and only two of the four types carry a name.

const OR_LUPITA = [
  {
    registry_number: '10000099', business_name: 'THE LUPITA COMPANY, LLC',
    entity_type: 'DOMESTIC LIMITED LIABILITY COMPANY',
    registry_date: '2002-08-26T00:00:00.000',
    associated_name_type: 'PRINCIPAL PLACE OF BUSINESS',
    address: '93175 POWERLINE RD', city: 'EUGENE', state: 'OR', zip: '97408',
  },
  {
    registry_number: '10000099', business_name: 'THE LUPITA COMPANY, LLC',
    entity_type: 'DOMESTIC LIMITED LIABILITY COMPANY',
    registry_date: '2002-08-26T00:00:00.000',
    associated_name_type: 'MAILING ADDRESS',
    address: '93175 POWERLINE RD', city: 'EUGENE', state: 'OR', zip: '97408',
  },
  {
    registry_number: '10000099', business_name: 'THE LUPITA COMPANY, LLC',
    entity_type: 'DOMESTIC LIMITED LIABILITY COMPANY',
    registry_date: '2002-08-26T00:00:00.000',
    associated_name_type: 'REGISTERED AGENT',
    first_name: 'GUADALUPE', last_name: 'JONES',
    address: '93175 POWERLINE RD', city: 'EUGENE', state: 'OR', zip: '97408',
  },
]

/** A company agent: `entity_of_record_name` instead of the person columns. */
const OR_WILLAMETTE = [
  {
    registry_number: '574418', business_name: 'WILLAMETTE UNIVERSITY',
    entity_type: 'DOMESTIC NONPROFIT CORPORATION',
    registry_date: '1853-01-20T23:52:58.000',
    associated_name_type: 'REGISTERED AGENT',
    entity_of_record_name: 'REGISTERED AGENTS INC',
    address: '5441 S MACADAM AVE STE R', city: 'PORTLAND', state: 'OR', zip: '97239',
  },
]

const OR_KOFFI = [
  {
    registry_number: '100000199', business_name: 'KOFFI DESSOU CONSULTING',
    entity_type: 'ASSUMED BUSINESS NAME',
    registry_date: '2014-02-28T17:05:58.000',
    associated_name_type: 'PRINCIPAL PLACE OF BUSINESS',
    address: '6101 SE CLATSOP ST', city: 'PORTLAND', state: 'OR', zip: '97206',
  },
  {
    registry_number: '100000199', business_name: 'KOFFI DESSOU CONSULTING',
    entity_type: 'ASSUMED BUSINESS NAME',
    registry_date: '2014-02-28T17:05:58.000',
    associated_name_type: 'AUTHORIZED REPRESENTATIVE',
    first_name: 'KOFFI', last_name: 'DESSOU',
    address: '6101 SE CLATSOP ST', city: 'PORTLAND', state: 'OR', zip: '97206',
  },
]

describe('Oregon: one entity per registry_number group', () => {
  it('collapses the four associated-name rows into one entity', () => {
    const e = orEntity(OR_LUPITA)
    expect(e.entityId).toBe('10000099')
    expect(e.name).toBe('THE LUPITA COMPANY, LLC')
    expect(e.state).toBe('OR')
  })

  it('takes the address from PRINCIPAL PLACE OF BUSINESS, not the agent row', () => {
    const e = orEntity(OR_LUPITA)
    expect(e.street).toBe('93175 POWERLINE RD')
    expect(e.city).toBe('EUGENE')
    expect(e.postalCode).toBe('97408')
  })

  it('reads the registered agent as a person and title-cases the name', () => {
    const e = orEntity(OR_LUPITA)
    expect(e.officers).toHaveLength(1)
    expect(e.officers[0]).toMatchObject({
      first: 'Guadalupe', last: 'Jones', kind: 'person',
      title: 'Registered Agent', source_field: 'registered_agent', rank: 5,
    })
  })

  it('rejects a company agent on the dataset’s own signal, not a heuristic', () => {
    // `entity_of_record_name` present means the agent is a company. Trusting
    // that is what keeps "REGISTERED AGENTS INC" out of the officer list.
    expect(orEntity(OR_WILLAMETTE).officers).toHaveLength(0)
  })

  it('ranks an authorized representative ahead of a registered agent', () => {
    const e = orEntity(OR_KOFFI)
    expect(e.officers[0]).toMatchObject({
      first: 'Koffi', last: 'Dessou', rank: 1,
      source_field: 'authorized_representative',
    })
  })

  it('keeps one row when the same person is both agent and representative', () => {
    const both = [
      ...OR_KOFFI,
      { ...OR_KOFFI[1], associated_name_type: 'REGISTERED AGENT' },
    ]
    const e = orEntity(both)
    expect(e.officers).toHaveLength(1)
    // The better-ranked role is the one that survives.
    expect(e.officers[0].source_field).toBe('authorized_representative')
  })

  it('records no county — Oregon publishes none, so the ZIP crosswalk resolves it', () => {
    expect(orEntity(OR_LUPITA).county).toBe('')
  })

  it('trims the registry date to an ISO day', () => {
    expect(orEntity(OR_LUPITA).filingDate).toBe('2002-08-26')
  })
})

// ── Connecticut ──────────────────────────────────────────────────────────────

const CT_MASTER = {
  id: '0018y000008aU74AAE', name: 'DENISE CHARLES DESIGNS LLC',
  status: 'Active', business_type: 'LLC',
  date_registration: '2023-04-12T00:00:00.000',
  // Verbatim: the master's address column is empty on most rows, active ones
  // included. This is why the address is taken off the principal.
  mailing_address: ', , , , ,',
}

const CT_PRINCIPALS = [
  {
    business_id: '0018y000008aU74AAE', firstname: 'Denise', lastname: 'Anghel',
    residence_street_address_1: '12 Elm St', residence_city: 'norwalk',
    residence_state: 'CT', residence_zip_code: '06851',
  },
  {
    business_id: '0018y000008aU74AAE', firstname: 'Carmen', lastname: 'Morales',
    residence_street_address_1: '9 Oak Ave', residence_city: 'norwalk',
    residence_state: 'CT', residence_zip_code: '06851',
  },
]

const CT_AGENT_INDIVIDUAL = {
  business_key: '0018y000008aU74AAE', type: 'Individual',
  firstname: 'Denise', lastname: 'Anghel',
  business_street_address_1: '12 Elm St', business_city: 'norwalk',
  business_state: 'CT', business_zip_code: '06851',
}

const CT_AGENT_COMPANY = {
  business_key: '0018y000008aU74AAE', type: 'Business',
  firstname: undefined, lastname: undefined,
  business_street_address_1: 'Goodwin Square 225 Asylum Street',
  business_city: 'Hartford', business_state: 'CT', business_zip_code: '06103',
}

describe('Connecticut: the principal/agent join', () => {
  it('takes every principal, in the registry’s own order', () => {
    const e = ctEntity(CT_MASTER, CT_PRINCIPALS, undefined)
    expect(e.officers.map(o => `${o.first} ${o.last}`))
      .toEqual(['Denise Anghel', 'Carmen Morales'])
    expect(e.officers[0].title).toBe('Principal')
  })

  it('ranks principals ahead of the registered agent', () => {
    const e = ctEntity(CT_MASTER, CT_PRINCIPALS, {
      ...CT_AGENT_INDIVIDUAL, firstname: 'William', lastname: 'Gonyer',
    })
    expect(e.officers.at(-1)).toMatchObject({
      first: 'William', last: 'Gonyer', source_field: 'registered_agent', rank: 8,
    })
    expect(e.officers[0].source_field).toBe('principal')
  })

  it('does not list a sole owner twice when they are their own agent', () => {
    const e = ctEntity(CT_MASTER, [CT_PRINCIPALS[0]], CT_AGENT_INDIVIDUAL)
    expect(e.officers).toHaveLength(1)
    expect(e.officers[0].source_field).toBe('principal')
  })

  it('admits only an Individual agent — Business is a filing service', () => {
    const e = ctEntity(CT_MASTER, [], CT_AGENT_COMPANY)
    expect(e.officers).toHaveLength(0)
  })

  it('ignores the Secretary of the State fallback agent', () => {
    const e = ctEntity(CT_MASTER, [], {
      business_key: CT_MASTER.id, type: 'Secretary of the State',
      firstname: 'Secretary', lastname: 'of State',
    })
    expect(e.officers).toHaveLength(0)
  })

  it('takes the address from the principal, since the master has none', () => {
    const e = ctEntity(CT_MASTER, CT_PRINCIPALS, undefined)
    expect(e.street).toBe('12 Elm St')
    expect(e.city).toBe('norwalk')
    expect(e.postalCode).toBe('06851')
  })

  it('falls back to the agent address when no principal carries one', () => {
    const e = ctEntity(CT_MASTER, [], CT_AGENT_INDIVIDUAL)
    expect(e.postalCode).toBe('06851')
  })

  it('records no county — CT publishes none', () => {
    expect(ctEntity(CT_MASTER, CT_PRINCIPALS, undefined).county).toBe('')
  })

  it('keeps the master status so an inactive entity is distinguishable', () => {
    expect(ctEntity(CT_MASTER, CT_PRINCIPALS, undefined).status).toBe('Active')
  })
})
