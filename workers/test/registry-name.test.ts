import { describe, it, expect } from 'vitest'
import {
  classifyRegistryName, isCommercialAgent, splitFloridaName,
  normaliseEntityName, FL_OWNER_GRADE_CODES,
} from '../src/lib/registry-name.js'

// Every case here is a real value pulled live from the NY dataset on
// 2026-08-17, searching Nassau county for entity names containing "MED SPA".
describe('classifyRegistryName — real NY values', () => {
  it('rejects the entity name repeated back', () => {
    // 53–56% of dos_process_name values are this.
    expect(classifyRegistryName('APHRODIETY MED SPA LLC', 'APHRODIETY MED SPA LLC'))
      .toMatchObject({ kind: 'company', reason: 'entity_name_repeat' })
    expect(classifyRegistryName('BELLA FIORE MED SPA INC.', 'BELLA FIORE MED SPA INC.'))
      .toMatchObject({ kind: 'company', reason: 'entity_name_repeat' })
  })

  it('rejects a shortened form of the entity name', () => {
    expect(classifyRegistryName('BELLA FIORE', 'BELLA FIORE MED SPA INC.'))
      .toMatchObject({ kind: 'company', reason: 'entity_name_repeat' })
  })

  it('rejects commercial agents and law firms', () => {
    expect(classifyRegistryName('SPIEGEL & UTRERA P.A., P.C.', 'CAREMED SPA & TREATMENT LLC'))
      .toMatchObject({ kind: 'company' })
    expect(classifyRegistryName("Gene Rosen's Law Firm", 'ALLURE MED SPAS INC.'))
      .toMatchObject({ kind: 'company' })
    expect(classifyRegistryName('CT CORPORATION SYSTEM', 'SOME MED SPA LLC'))
      .toMatchObject({ kind: 'company', reason: 'commercial_agent' })
  })

  it('accepts a real officer name', () => {
    // chairman_name on DREAM SKIN CARE & MED SPA INC.
    expect(classifyRegistryName('UZMA IQBAL', 'DREAM SKIN CARE & MED SPA INC.'))
      .toMatchObject({ kind: 'person', first: 'Uzma', last: 'Iqbal' })
  })

  it('rejects a person-shaped string carrying an org marker', () => {
    expect(classifyRegistryName('SMITH & ASSOCIATES', 'RADIANCE LLC'))
      .toMatchObject({ kind: 'company', reason: 'org_marker' })
  })
})

describe('isCommercialAgent', () => {
  it.each([
    'REGISTERED AGENTS INC',
    'Corporation Service Company',
    'Northwest Registered Agent LLC',
    'LegalZoom.com, Inc.',
    'SPIEGEL & UTRERA P.A.',
  ])('flags %s', v => expect(isCommercialAgent(v)).toBe(true))

  it('does not flag an ordinary person', () => {
    expect(isCommercialAgent('UZMA IQBAL')).toBe(false)
  })
})

describe('normaliseEntityName', () => {
  it('strips suffixes so the repeat test can see through them', () => {
    expect(normaliseEntityName('BELLA FIORE MED SPA INC.')).toBe('bella fiore med spa')
    expect(normaliseEntityName('APHRODIETY MED SPA LLC')).toBe('aphrodiety med spa')
  })
})

// Measured from doc/cor/20260815c.txt: the 42-char name slot is a 20-char
// space-padded LAST followed by FIRST. Splitting on whitespace inverts the
// name on every Florida row, so this is asserted rather than assumed.
describe('splitFloridaName', () => {
  it('reads the fixed sub-fields, not whitespace', () => {
    expect(splitFloridaName('JOVER               DANIELLA'))
      .toEqual({ first: 'Daniella', last: 'Jover' })
    expect(splitFloridaName('HAGAN               NANAJACOB'))
      .toEqual({ first: 'Nanajacob', last: 'Hagan' })
    expect(splitFloridaName('HALL                JOHN'))
      .toEqual({ first: 'John', last: 'Hall' })
  })

  it('does NOT produce first=Jover, which whitespace splitting would', () => {
    const { first } = splitFloridaName('JOVER               DANIELLA')
    expect(first).not.toBe('Jover')
  })

  it('returns a flat company name whole rather than slicing it at column 20', () => {
    // "REGISTERED AGENTS INC" is 21 chars and runs straight through the
    // sub-field boundary. Slicing gave last="REGISTERED AGENTS IN", first="C".
    expect(splitFloridaName('REGISTERED AGENTS INC'))
      .toEqual({ first: '', last: 'REGISTERED AGENTS INC' })
  })

  it('still splits a padded name whose last name is long', () => {
    expect(splitFloridaName('FERNANDEZ-GONZALEZ  ROBERTO'))
      .toEqual({ first: 'Roberto', last: 'Fernandez-Gonzalez' })
  })

  it('handles a multi-word first name after column 20', () => {
    expect(splitFloridaName('DE LA CRUZ           MARIA JOSE'))
      .toMatchObject({ last: 'De La Cruz' })
  })
})

describe('FL_OWNER_GRADE_CODES', () => {
  it('covers the codes that dominate the file', () => {
    // MGR 775, AMBR 548, CEO 34, MBR 34 on the sample day.
    for (const code of ['MGR', 'AMBR', 'MBR', 'CEO', 'PRES', 'P']) {
      expect(FL_OWNER_GRADE_CODES.has(code)).toBe(true)
    }
  })

  it('does not treat a plain authorised representative as owner-grade', () => {
    expect(FL_OWNER_GRADE_CODES.has('AR')).toBe(false)
  })
})
