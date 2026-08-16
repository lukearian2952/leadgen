import { describe, it, expect } from 'vitest'
import {
  renderPattern, inferPattern, candidatesFor, foldPattern, PATTERN_ORDER,
} from '../src/lib/patterns.js'

describe('renderPattern', () => {
  it('renders each shape', () => {
    const cases: Array<[Parameters<typeof renderPattern>[0], string]> = [
      ['first', 'jane@x.com'], ['first.last', 'jane.smith@x.com'],
      ['flast', 'jsmith@x.com'], ['firstl', 'janes@x.com'],
      ['f.last', 'j.smith@x.com'], ['first_last', 'jane_smith@x.com'],
      ['last', 'smith@x.com'],
    ]
    for (const [p, expected] of cases) {
      expect(renderPattern(p, 'Jane', 'Smith', 'x.com')).toBe(expected)
    }
  })

  it('strips accents and non-letters', () => {
    expect(renderPattern('first.last', 'José', "O'Brien", 'x.com')).toBe('jose.obrien@x.com')
  })

  // Returning a truncated address would put junk into the candidate list and
  // spend a verification on something that cannot exist.
  it('returns empty for last-name shapes when there is no last name', () => {
    for (const p of PATTERN_ORDER.filter(p => p !== 'first')) {
      expect(renderPattern(p, 'Jane', '', 'x.com')).toBe('')
    }
    expect(renderPattern('first', 'Jane', '', 'x.com')).toBe('jane@x.com')
  })
})

describe('inferPattern', () => {
  it('recognises the shape of a known-good address', () => {
    expect(inferPattern('jane.smith@x.com', 'Jane', 'Smith')).toBe('first.last')
    expect(inferPattern('jsmith@x.com', 'Jane', 'Smith')).toBe('flast')
    expect(inferPattern('jane@x.com', 'Jane', 'Smith')).toBe('first')
  })

  // A personal mailbox that follows no convention teaches nothing. Recording
  // one as a pattern would poison every future candidate on the domain.
  it('returns null when the local part matches no shape', () => {
    expect(inferPattern('drjane@x.com', 'Jane', 'Smith')).toBeNull()
    expect(inferPattern('smithdental@x.com', 'Jane', 'Smith')).toBeNull()
    expect(inferPattern('info@x.com', 'Jane', 'Smith')).toBeNull()
  })
})

describe('candidatesFor', () => {
  it('collapses to ONE candidate when the pattern is known', () => {
    // The whole economic argument: one SMTP probe instead of six.
    expect(candidatesFor('Jane', 'Smith', 'x.com', 'flast')).toEqual(['jsmith@x.com'])
  })

  it('falls back to the ladder when no pattern is known', () => {
    const c = candidatesFor('Jane', 'Smith', 'x.com', null)
    expect(c.length).toBeGreaterThan(1)
    expect(c[0]).toBe('jane.smith@x.com')   // most common shape first
    expect(c).toContain('jsmith@x.com')
  })

  it('falls back when the known pattern needs a last name we lack', () => {
    const c = candidatesFor('Jane', '', 'x.com', 'first.last')
    expect(c).toEqual(['jane@x.com'])
  })

  it('returns nothing without a first name or domain', () => {
    expect(candidatesFor('', 'Smith', 'x.com')).toEqual([])
    expect(candidatesFor('Jane', 'Smith', '')).toEqual([])
  })

  it('respects the max', () => {
    expect(candidatesFor('Jane', 'Smith', 'x.com', null, 2)).toHaveLength(2)
  })
})

describe('foldPattern', () => {
  it('learns a pattern from the first verified address', () => {
    const r = foldPattern(null, 'jane.smith@x.com', 'Jane', 'Smith')
    expect(r).toMatchObject({ domain: 'x.com', pattern: 'first.last', samples: 1 })
    expect(r!.confidence).toBeGreaterThan(0.5)
  })

  it('raises confidence when a second address agrees', () => {
    const first = foldPattern(null, 'jane.smith@x.com', 'Jane', 'Smith')!
    const second = foldPattern(first, 'bob.jones@x.com', 'Bob', 'Jones')!
    expect(second.pattern).toBe('first.last')
    expect(second.samples).toBe(2)
    expect(second.confidence).toBeGreaterThan(first.confidence)
  })

  // Domains genuinely run mixed conventions. Flipping on the first
  // disagreement would thrash between them; the well-evidenced guess should
  // survive a single outlier.
  it('does not flip on one disagreement, only weakens', () => {
    let rec = foldPattern(null, 'jane.smith@x.com', 'Jane', 'Smith')!
    rec = foldPattern(rec, 'bob.jones@x.com', 'Bob', 'Jones')!   // 0.75
    const after = foldPattern(rec, 'kwong@x.com', 'Kim', 'Wong')!
    expect(after.pattern).toBe('first.last')
    expect(after.confidence).toBeLessThan(rec.confidence)
  })

  it('eventually flips once the old pattern is out-voted', () => {
    let rec = foldPattern(null, 'jane.smith@x.com', 'Jane', 'Smith')!  // 0.6
    rec = foldPattern(rec, 'kwong@x.com', 'Kim', 'Wong')!              // weakened to 0.35 -> flips
    expect(rec.pattern).toBe('flast')
  })

  it('ignores an address that matches no shape', () => {
    const rec = foldPattern(null, 'drjane@x.com', 'Jane', 'Smith')
    expect(rec).toBeNull()
  })
})
