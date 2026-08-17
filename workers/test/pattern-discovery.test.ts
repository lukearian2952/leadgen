import { describe, it, expect } from 'vitest'
import {
  discoverPattern, domainHasPublishedMailbox, addressesFromText, addressQuery,
} from '../src/lib/pattern-discovery.js'
import {
  candidateLadder, followsAcceptedShape, renderPattern, inferPattern,
} from '../src/lib/patterns.js'

const people = [{ first: 'Sarah', last: 'Kandhorov' }]

describe('discoverPattern', () => {
  it('reads the convention off a published personal address', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [{ email: 'sarah.kandhorov@novamedspa.com', source: 'site_crawl' }],
      people,
    })
    expect(out.discovered).toMatchObject({
      pattern: 'first.last', source: 'site_crawl',
      learnedFrom: 'sarah.kandhorov@novamedspa.com',
      matchedPerson: 'Sarah Kandhorov',
    })
  })

  it('learns from a staff member, not only the owner', () => {
    // A receptionist's address teaches the domain's shape just as well.
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [{ email: 'jenna.wu@novamedspa.com', source: 'site_crawl' }],
      people: [{ first: 'Sarah', last: 'Kandhorov' }, { first: 'Jenna', last: 'Wu' }],
    })
    expect(out.discovered?.pattern).toBe('first.last')
  })

  it('ignores role inboxes — info@ matches no pattern', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [{ email: 'info@novamedspa.com', source: 'site_crawl' }],
      people,
    })
    expect(out.discovered).toBeNull()
    // But it still counts as proof the domain receives mail.
    expect(out.onDomainAddresses).toEqual(['info@novamedspa.com'])
    expect(out.personalAddresses).toEqual([])
  })

  it('ignores addresses on other domains', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [
        { email: 'support@wixpress.com', source: 'site_crawl' },
        { email: 'thedesigner@gmail.com', source: 'site_crawl' },
        { email: 'noreply@sentry.io', source: 'site_crawl' },
      ],
      people,
    })
    expect(out.discovered).toBeNull()
    expect(out.onDomainAddresses).toEqual([])
  })

  it('accepts a subdomain of the same root', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [{ email: 'sarah.kandhorov@mail.novamedspa.com', source: 'site_crawl' }],
      people,
    })
    expect(out.discovered?.pattern).toBe('first.last')
  })

  it('prefers the site over a SERP result when both match', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [
        { email: 'skandhorov@novamedspa.com', source: 'serp' },
        { email: 'sarah.kandhorov@novamedspa.com', source: 'site_crawl' },
      ],
      people,
    })
    expect(out.discovered).toMatchObject({ source: 'site_crawl', pattern: 'first.last' })
  })

  it('returns nothing when no address ties to a named person', () => {
    const out = discoverPattern({
      domain: 'novamedspa.com',
      addresses: [{ email: 'drjane@novamedspa.com', source: 'site_crawl' }],
      people,
    })
    expect(out.discovered).toBeNull()
  })
})

describe('domainHasPublishedMailbox', () => {
  it('is true for a role inbox on the domain', () => {
    const out = discoverPattern({
      domain: 'theclinic.com',
      addresses: [{ email: 'info@theclinic.com', source: 'gbp' }],
      people: [],
    })
    expect(domainHasPublishedMailbox(out)).toBe(true)
  })

  it('is false when nothing on the domain was ever published', () => {
    const out = discoverPattern({ domain: 'theclinic.com', addresses: [], people: [] })
    expect(domainHasPublishedMailbox(out)).toBe(false)
  })
})

describe('addressesFromText', () => {
  it('pulls on-domain addresses out of a SERP snippet', () => {
    const text = 'Contact us at hello@novamedspa.com or sarah.kandhorov@novamedspa.com — also foo@other.com'
    expect(addressesFromText(text, 'novamedspa.com').sort())
      .toEqual(['hello@novamedspa.com', 'sarah.kandhorov@novamedspa.com'])
  })

  it('builds the query the brief specifies', () => {
    expect(addressQuery('novamedspa.com')).toBe('"@novamedspa.com"')
  })
})

describe('the four extra patterns', () => {
  it.each([
    ['firstlast', 'janesmith@x.com'],
    ['lastfirst', 'smithjane@x.com'],
    ['first_l',   'jane_s@x.com'],
    ['f_last',    'j_smith@x.com'],
  ] as const)('renders and round-trips %s', (pattern, expected) => {
    expect(renderPattern(pattern, 'Jane', 'Smith', 'x.com')).toBe(expected)
    expect(inferPattern(expected, 'Jane', 'Smith')).toBe(pattern)
  })
})

describe('candidateLadder', () => {
  it('puts the learned pattern first, then six, then the extras', () => {
    const out = candidateLadder('Jane', 'Smith', 'x.com', 'f_last')
    expect(out[0]).toBe('j_smith@x.com')
    expect(out).toHaveLength(11)
    // The standard six come before the remaining extras.
    expect(out.indexOf('jane.smith@x.com')).toBeLessThan(out.indexOf('janesmith@x.com'))
  })

  it('does not duplicate the learned pattern lower down', () => {
    const out = candidateLadder('Jane', 'Smith', 'x.com', 'first.last')
    expect(out.filter(e => e === 'jane.smith@x.com')).toHaveLength(1)
  })

  it('degrades to first-name-only shapes with no last name', () => {
    expect(candidateLadder('Jane', '', 'x.com')).toEqual(['jane@x.com'])
  })
})

describe('followsAcceptedShape — the catch-all guard', () => {
  it('accepts first@ and first.last@ with no learned pattern', () => {
    expect(followsAcceptedShape('jane@x.com', 'Jane', 'Smith')).toMatchObject({ ok: true })
    expect(followsAcceptedShape('jane.smith@x.com', 'Jane', 'Smith')).toMatchObject({ ok: true })
  })

  it('rejects a rare corporate shape guessed onto a catch-all', () => {
    // jsmith@ verifies `safe` on a catch-all whether or not it exists.
    expect(followsAcceptedShape('jsmith@x.com', 'Jane', 'Smith')).toMatchObject({ ok: false })
    expect(followsAcceptedShape('smithjane@x.com', 'Jane', 'Smith')).toMatchObject({ ok: false })
  })

  it('accepts any shape the domain is known to use', () => {
    expect(followsAcceptedShape('jsmith@x.com', 'Jane', 'Smith', 'flast'))
      .toMatchObject({ ok: true, pattern: 'flast' })
  })

  it('rejects an address that matches no pattern at all', () => {
    expect(followsAcceptedShape('drjane@x.com', 'Jane', 'Smith'))
      .toMatchObject({ ok: false, pattern: null })
  })
})
