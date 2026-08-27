// SaaS discovery: the filtering and naming that separate a vendor's own site
// from everything else search returns.
//
// The hosts and titles below are copied from a real SearXNG response for
// `"practice management software" pricing` on 2026-08-26 — 39 results, 36
// hosts, of which roughly a third were dictionaries and review aggregators.
// That ratio is the reason the exclusion lists exist, so the test is written
// against the actual result set rather than an imagined one.

import { describe, it, expect } from 'vitest'
import {
  isExcludedHost, saasQueries, candidatesFrom, vendorName, domainToName,
  nichePhrases,
} from '../src/sources/saas.js'
import type { SerpResult } from '../src/sources/serp.js'

const result = (url: string, title = ''): SerpResult =>
  ({ url, title, content: '', engine: 'bing' })

describe('isExcludedHost', () => {
  it('keeps the vendor domains that query actually returned', () => {
    for (const host of [
      'simplepractice.com', 'practicepanther.com', 'archy.com', 'rocketmatter.com',
      'omnimd.com', 'centerbase.com', 'zandahealth.com', 'mangopractice.com',
      'firmflow.io', 'getruana.com', 'vozohealth.com', 'tidyflow.com',
    ]) {
      expect(isExcludedHost(host), host).toBe(false)
    }
  })

  it('drops the review aggregators, which outrank every vendor by design', () => {
    // These are not leads: nobody at capterra.com owns the software.
    for (const host of [
      'g2.com', 'capterra.com', 'softwareadvice.com', 'getapp.com',
      'goodfirms.co', 'trustradius.com', 'klasresearch.com', 'priceithere.com',
    ]) {
      expect(isExcludedHost(host), host).toBe(true)
    }
  })

  it('drops the dictionaries, which a niche made of English words always pulls in', () => {
    for (const host of [
      'merriam-webster.com', 'dictionary.cambridge.org', 'thefreedictionary.com',
      'vocabulary.com', 'grammar-monster.com', 'dictionary.com', 'keybr.com',
      'wordreference.com',
    ]) {
      expect(isExcludedHost(host), host).toBe(true)
    }
  })

  it('drops encyclopaedias, forums and social', () => {
    for (const host of [
      'en.wikipedia.org', 'en.m.wiktionary.org', 'reddit.com', 'quora.com',
      'linkedin.com', 'youtube.com', 'medium.com',
    ]) {
      expect(isExcludedHost(host), host).toBe(true)
    }
  })

  it('drops subdomains of an excluded host, not just the bare host', () => {
    expect(isExcludedHost('blog.capterra.com')).toBe(true)
    expect(isExcludedHost('en.m.wikipedia.org')).toBe(true)
  })

  it('drops government, military and academic sites', () => {
    for (const host of ['cms.gov', 'health.mil', 'stanford.edu']) {
      expect(isExcludedHost(host), host).toBe(true)
    }
  })

  it('drops site-builder placeholder domains via the shared junk list', () => {
    expect(isExcludedHost('mysite.wixsite.com')).toBe(true)
  })

  it('is not fooled by a leading www.', () => {
    expect(isExcludedHost('www.capterra.com')).toBe(true)
  })
})

describe('nichePhrases', () => {
  it('swaps the category word, because vendors do not call themselves SaaS', () => {
    // Measured: "practice management SaaS" alone found 49 vendors against a
    // target of 100. The word a buyer types is not the word on the homepage.
    const phrases = nichePhrases('practice management SaaS')
    expect(phrases[0]).toBe('practice management saas')
    expect(phrases).toContain('practice management software')
    expect(phrases).toContain('practice management platform')
  })

  it('keeps the caller\'s own wording first', () => {
    expect(nichePhrases('practice management software')[0])
      .toBe('practice management software')
  })

  it('leaves a niche with no category word alone', () => {
    // Inventing "dental implants platform" would search for something nobody
    // writes.
    expect(nichePhrases('dental implants')).toEqual(['dental implants'])
  })

  it('does not turn a bare category word into a stemless query', () => {
    expect(nichePhrases('software')).toEqual(['software'])
  })

  it('returns nothing for an empty niche', () => {
    expect(nichePhrases('  ')).toEqual([])
  })
})

describe('saasQueries', () => {
  it('crosses phrase variants with intent suffixes', () => {
    const queries = saasQueries('practice management SaaS', 'United States', 3)
    expect(queries).toHaveLength(15)   // 3 phrases x 5 intents
    expect(queries.some(q => q.includes('"practice management software"'))).toBe(true)
  })

  it('honours the phrase cap so a run cannot fan out unboundedly', () => {
    expect(saasQueries('practice management SaaS', '', 1)).toHaveLength(5)
  })

  it('uses buying-intent phrasing, not "best X"', () => {
    // "best practice management software" was tried first and returned six
    // dictionary definitions of the word "best" in the top ten.
    const queries = saasQueries('practice management software', 'United States')
    expect(queries.join(' ')).not.toMatch(/\bbest\b/i)
    expect(queries.some(q => q.includes('pricing'))).toBe(true)
    expect(queries.some(q => q.includes('request a demo'))).toBe(true)
  })

  it('quotes the phrase so the engines match it, not the separate words', () => {
    for (const q of saasQueries('practice management software', '', 1)) {
      expect(q).toContain('"practice management software"')
    }
  })

  it('does not append a whole-country location', () => {
    // "United States" as a search term pulls in directories of US companies
    // rather than narrowing to US vendors.
    for (const q of saasQueries('crm software', 'United States')) {
      expect(q.toLowerCase()).not.toContain('united states')
    }
  })

  it('does append a location specific enough to narrow', () => {
    const queries = saasQueries('crm software', 'Austin, TX')
    expect(queries.every(q => q.includes('Austin, TX'))).toBe(true)
  })

  it('strips quotes out of the niche so the query cannot be broken', () => {
    expect(saasQueries('say "hello" software', '', 1)[0]).toBe('"say hello software" pricing')
  })
})

describe('candidatesFrom', () => {
  it('deduplicates a domain seen across several queries and counts the hits', () => {
    const candidates = candidatesFrom([
      [result('https://www.simplepractice.com/pricing/', 'SimplePractice | Pricing')],
      [result('https://simplepractice.com/demo', 'SimplePractice | Book a demo')],
      [result('https://archy.com/', 'Archy | Dental software')],
    ])
    expect(candidates).toHaveLength(2)
    const simple = candidates.find(c => c.domain === 'simplepractice.com')!
    expect(simple.hits).toBe(2)
    expect(candidates.find(c => c.domain === 'archy.com')!.hits).toBe(1)
  })

  it('ranks a domain that several queries agree on above a one-off', () => {
    const candidates = candidatesFrom([
      [result('https://oneoff.com/', 'One Off')],
      [result('https://both.com/', 'Both')],
      [result('https://both.com/x', 'Both')],
    ])
    expect(candidates[0].domain).toBe('both.com')
  })

  it('excludes junk before it can consume a slot', () => {
    const candidates = candidatesFrom([[
      result('https://www.capterra.com/x', 'Capterra'),
      result('https://www.merriam-webster.com/dictionary/best', 'Best'),
      result('https://practicepanther.com/', 'PracticePanther | Legal software'),
    ]])
    expect(candidates.map(c => c.domain)).toEqual(['practicepanther.com'])
  })

  it('survives a result whose url will not parse', () => {
    const candidates = candidatesFrom([[result('not a url', 'x')]])
    expect(candidates).toEqual([])
  })
})

describe('vendorName', () => {
  it('takes the brand before the separator, not the whole marketing title', () => {
    // The whole title would go into `business_name`, which registry:match then
    // trigram-matches against company registrations.
    expect(vendorName('SimplePractice | EHR and Practice Management Software', 'simplepractice.com'))
      .toBe('SimplePractice')
    expect(vendorName('Archy – The all-in-one dental software', 'archy.com'))
      .toBe('Archy')
    expect(vendorName('RocketMatter: Legal Practice Management', 'rocketmatter.com'))
      .toBe('RocketMatter')
  })

  it('falls back to the domain when the title is a sentence', () => {
    expect(vendorName(
      'The 12 best practice management platforms for growing clinics in 2026',
      'practicepanther.com')).toBe('Practicepanther')
  })

  it('falls back to the domain when there is no title at all', () => {
    expect(vendorName('', 'zandahealth.com')).toBe('Zandahealth')
  })

  it('does not accept a URL as a brand name', () => {
    expect(vendorName('https://example.com/page', 'example.com')).toBe('Example')
  })
})

describe('domainToName', () => {
  it('capitalises the second-level label and drops separators', () => {
    expect(domainToName('practice-web.com')).toBe('Practice web')
    expect(domainToName('www.getcanopy.com')).toBe('Getcanopy')
    expect(domainToName('firmflow.io')).toBe('Firmflow')
  })
})
