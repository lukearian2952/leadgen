import { describe, it, expect } from 'vitest'
import { extractEmails } from '../src/sources/crawl.js'
import { isGenericLocalPart } from '../src/lib/identity.js'

describe('extractEmails — mailto decoding', () => {
  it('strips URL-encoded whitespace', () => {
    // Observed live on ourskinspace.com: `mailto:%20info@...` was stored as
    // " info@ourskinspace.com". A leading space makes the local part fail the
    // role-inbox test, so a front-desk address was counted as a personal one —
    // and the on-domain-personal count is now a reported metric that predicts
    // Tier A, so it has to be right.
    const found = extractEmails('<a href="mailto:%20info@ourskinspace.com">Email</a>')
    expect(found).toEqual(['info@ourskinspace.com'])
    expect(isGenericLocalPart(found[0])).toBe(true)
  })

  it('strips whitespace anywhere, not just the ends', () => {
    expect(extractEmails('<a href="mailto:info%20@x.com">x</a>')).toEqual(['info@x.com'])
  })

  it('survives a malformed percent-escape instead of throwing', () => {
    // decodeURIComponent('%zz') raises URIError; the crawl must not die on it.
    expect(() => extractEmails('<a href="mailto:%zzinfo@x.com">x</a>')).not.toThrow()
  })

  it('still decodes ordinary escapes', () => {
    expect(extractEmails('<a href="mailto:jane%2Esmith@x.com">x</a>'))
      .toEqual(['jane.smith@x.com'])
  })

  it('still finds bare addresses in text', () => {
    expect(extractEmails('write to jane.smith@x.com today')).toEqual(['jane.smith@x.com'])
  })

  it('excludes asset filenames that look like addresses', () => {
    expect(extractEmails('<img src="sprite@2x.png">')).toEqual([])
  })

  it('puts on-domain addresses first', () => {
    const out = extractEmails(
      'a@other.com and b@mine.com', 'mine.com')
    expect(out[0]).toBe('b@mine.com')
  })
})
