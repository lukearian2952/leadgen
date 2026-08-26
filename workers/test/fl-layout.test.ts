// The Florida fixed-width layout, asserted against real bytes.
//
// `test/fixtures/fl-cor-sample.txt` holds four unmodified records taken from
// `doc/cor/20260815c.txt` on the live Sunbiz SFTP: a person registered agent,
// a company registered agent, a two-officer entity, and a CEO with a middle
// initial. A layout like this is either exactly right or it silently produces
// plausible garbage — "Daniella Jover" read as "Jover Daniella" is a real name
// and a wrong one — so it is checked against the file rather than the spec.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseRecord, recentDailyFiles, isoFilingDate } from '../src/sources/registry/fl.js'

const here = dirname(fileURLToPath(import.meta.url))
const lines = readFileSync(join(here, 'fixtures/fl-cor-sample.txt'), 'latin1')
  .split(/\r?\n/).filter(Boolean)

describe('the fixture itself', () => {
  it('holds four records of exactly 1440 characters', () => {
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(line).toHaveLength(1440)
  })
})

describe('parseRecord', () => {
  it('reads the entity fields', () => {
    const e = parseRecord(lines[0])
    expect(e.state).toBe('FL')
    expect(e.name).toBe('OMOIYARI MORTUARY SERVICE LLC')
    expect(e.entityId).toMatch(/^L\d+$/)
    expect(e.status).toBe('Active')
    expect(e.city).toBe('PEMBROKE PINES')
    expect(e.postalCode).toBe('33028')
    // The state column is blank on Florida-domestic records.
    expect(e.stateCode).toBe('FL')
  })

  it('reads the officer name as LAST(20) + FIRST, not "First Last"', () => {
    const e = parseRecord(lines[0])
    const officer = e.officers[0]
    expect(officer.first).toBe('Daniella')
    expect(officer.last).toBe('Jover')
    expect(officer.title).toBe('Manager')       // MGR
    expect(officer.source_field).toBe('officer_1')
  })

  it('trusts the file\'s own C flag and drops company registered agents', () => {
    // NANA'S WAREHOUSE LLC: agent is REGISTERED AGENTS INC, flagged C.
    const e = parseRecord(lines[1])
    expect(e.name).toBe("NANA'S WAREHOUSE LLC")
    expect(e.officers.some(o => /registered agents/i.test(o.name))).toBe(false)
    // Its actual member is a person and survives.
    expect(e.officers[0]).toMatchObject({ first: 'Nanajacob', last: 'Hagan' })
  })

  it('reads multiple officer slots', () => {
    const e = parseRecord(lines[2])
    expect(e.name).toBe('JAMES-GUTZMERE PREMIER STAYS LLC')
    expect(e.officers.length).toBeGreaterThanOrEqual(2)
    for (const o of e.officers) expect(o.last).toBe('James')
  })

  it('strips the middle initial from the first name', () => {
    // "MANNERING           SAMMY         J" — three sub-fields, not two.
    const e = parseRecord(lines[3])
    expect(e.name).toBe('VERIVANT TECHNOLOGIES LLC')
    const ceo = e.officers.find(o => o.title === 'Chief Executive Officer')
    expect(ceo).toBeDefined()
    expect(ceo!.first).toBe('Sammy')
    expect(ceo!.last).toBe('Mannering')
    // And not "Sammy         J"
    expect(ceo!.first).not.toMatch(/\s/)
  })

  it('ranks owner-grade title codes ahead of the registered agent', () => {
    const e = parseRecord(lines[3])
    // CEO (owner-grade) before the registered-agent fallback at rank 8.
    expect(e.officers[0].rank).toBeLessThan(8)
  })

  it('normalises the name for trigram matching', () => {
    const e = parseRecord(lines[0])
    expect(e.nameNorm).toBe('omoiyari mortuary service')
  })

  // The previous version of this test asserted only `/^\d{4}-\d{2}-\d{2}$/`,
  // which "0811-20-26" satisfies — so a date read in entirely the wrong order
  // passed for as long as FL was never actually ingested. Assert the value.
  it('reads the filing date as mmddyyyy, not yyyymmdd', () => {
    // These four records come from doc/cor/20260815c.txt and all carry
    // `08112026`: 11 August 2026, four days before the file was published.
    // Read as yyyymmdd that is year 0811, month 20.
    for (const line of lines) {
      expect(parseRecord(line).filingDate).toBe('2026-08-11')
    }
  })

  it('drops a filing date that is eight digits but not a date', () => {
    // The quarterly archive carries values like this, and one of them aborted
    // a whole ingest after a 1.8 GB download. The row is still worth keeping —
    // it names an officer — so the date goes and the record stays.
    expect(isoFilingDate('00000000')).toBeNull()
    expect(isoFilingDate('13012020')).toBeNull()
    expect(isoFilingDate('02302011')).toBeNull()
    expect(isoFilingDate('1234')).toBeNull()
  })

  it('accepts the real dates either end of the plausible range', () => {
    expect(isoFilingDate('12311999')).toBe('1999-12-31')
    expect(isoFilingDate('11162011')).toBe('2011-11-16')
  })
})

describe('recentDailyFiles', () => {
  it('names files in Sunbiz\'s yyyymmddc.txt shape', () => {
    const files = recentDailyFiles(3, new Date('2026-08-17T00:00:00Z'))
    expect(files).toHaveLength(3)
    for (const f of files) expect(f).toMatch(/^\d{8}c\.txt$/)
  })

  it('skips weekends — Sunbiz files only on work days', () => {
    // 2026-08-17 is a Monday; the three prior work days are Fri 14, Thu 13, Wed 12.
    expect(recentDailyFiles(3, new Date('2026-08-17T12:00:00Z')))
      .toEqual(['20260814c.txt', '20260813c.txt', '20260812c.txt'])
  })

  it('never asks for today, which may not be published yet', () => {
    const files = recentDailyFiles(1, new Date('2026-08-14T12:00:00Z'))
    expect(files[0]).not.toBe('20260814c.txt')
  })
})
