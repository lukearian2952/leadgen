// The SERP phrasing experiment: which queries go out for which kind of niche.
//
// The baseline these replace is not "6 per 100". serp:owner ran on 100 leads of
// campaign 0880d44f and produced 6 candidates, but it ran on exactly the 93
// that are still unnamed plus 7 that were named by other means — and all 6 came
// from those 7. Over the cohort the experiment actually re-runs, the
// brick-and-mortar phrasing scored 0 of 93.

import { describe, it, expect } from 'vitest'
import { ownerQueries, founderQueries, websiteDomain } from '../src/sources/serp.js'
import { resolveNicheFilter } from '../src/lib/niche-types.js'

describe('founderQueries — the online phrasing', () => {
  const q = founderQueries('Acme Practice Software', 'https://www.acmepractice.io/pricing')

  it('asks LinkedIn for a title rather than a bare company name', () => {
    // The bare-name form ranks employees above the two founders.
    expect(q[0]).toBe('"Acme Practice Software" founder OR CEO OR "co-founder" site:linkedin.com/in')
    expect(q).not.toContain('site:linkedin.com/in "Acme Practice Software"')
  })

  it('asks the open web for the founding story', () => {
    expect(q[1]).toBe('"Acme Practice Software" "founded by" OR "our story"')
  })

  it('scopes the about/team query to the vendor\'s own domain', () => {
    expect(q[2]).toBe('site:acmepractice.io about OR team OR leadership')
  })

  it('never says "owner" — the word a software company does not use', () => {
    expect(q.join(' ')).not.toMatch(/\bowner\b/i)
  })

  it('drops the site: query rather than emitting an unscoped one', () => {
    // Unscoped, `about OR team OR leadership` competes with the whole web.
    for (const bad of [null, undefined, '', '   ', 'not a url']) {
      const only = founderQueries('Acme', bad as string | null)
      expect(only).toHaveLength(2)
      expect(only.some(s => s.startsWith('site:') && !s.includes('linkedin'))).toBe(false)
    }
  })

  it('strips quotes from a company name so the phrase query stays valid', () => {
    expect(founderQueries('The "Best" CRM', null)[0])
      .toBe('"The Best CRM" founder OR CEO OR "co-founder" site:linkedin.com/in')
  })
})

describe('ownerQueries — unchanged for brick-and-mortar', () => {
  it('still asks the local phrasing', () => {
    expect(ownerQueries('Bella Fiore Med Spa', 'Oceanside')).toEqual([
      '"Bella Fiore Med Spa" Oceanside owner OR founder',
      'site:linkedin.com/in "Bella Fiore Med Spa"',
    ])
  })
})

describe('the discriminator', () => {
  // Every rule in niche-types is a brick-and-mortar trade and none sets serp,
  // so `serp === true` comes only from the no-rule fallback. That is what the
  // job branches on; if a rule ever sets serp:true this test fails and the
  // branch needs a more specific condition.
  it('is true for online niches and false for trades', () => {
    expect(resolveNicheFilter('practice management software').serp).toBe(true)
    expect(resolveNicheFilter('B2B SaaS').serp).toBe(true)
    expect(resolveNicheFilter('med spa').serp).toBe(false)
    expect(resolveNicheFilter('car wrap').serp).toBe(false)
    expect(resolveNicheFilter('dental').serp).toBe(false)
  })
})

describe('websiteDomain', () => {
  it('strips scheme, www and path', () => {
    expect(websiteDomain('https://www.foo.com/about?x=1')).toBe('foo.com')
    expect(websiteDomain('foo.co.uk')).toBe('foo.co.uk')
  })
  it('returns null for junk rather than throwing', () => {
    expect(websiteDomain(null)).toBeNull()
    expect(websiteDomain('::::')).toBeNull()
  })
})

// ── the boot regression ──────────────────────────────────────────────────────
//
// Six of seven workers crash-looped on the first restart after the registry
// moved out of Supabase: `buildTaskList` constructed every stage's task before
// filtering by role, and `makeRegistryIngestTask` resolves the registry pool at
// construction. Nothing had restarted between that commit and this one, so the
// break sat latent in a deployed system for a day.
describe('buildTaskList — only the role\'s stages are constructed', () => {
  // serp and scheduler stand in for the six that crash-looped. crawl is the
  // same defect but cannot be asserted this cheaply: makeCrawlSiteTask builds a
  // real ProxyPool at construction and so needs a full proxy config, which
  // would make this a test of the fixture rather than of the filtering.
  it.each(['serp', 'scheduler'] as const)(
    'builds the %s role with no registry pool', async role => {
      const { buildTaskList, stagesForRole } = await import('../src/jobs/index.js')
      const deps = {
        config: { role },
        db: {} as never,
        registryDb: null,
        logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
      } as never

      const tasks = buildTaskList(deps)
      expect(Object.keys(tasks).sort())
        .toEqual(['ping', ...stagesForRole(role)].sort())
      expect(Object.keys(tasks)).not.toContain('registry:ingest')
    })

  it('still builds the registry stages when the role asks for them', async () => {
    const { buildTaskList } = await import('../src/jobs/index.js')
    const deps = {
      config: { role: 'registry' },
      db: {} as never,
      registryDb: {} as never,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
    } as never
    expect(Object.keys(buildTaskList(deps)).sort())
      .toEqual(['ping', 'registry:ingest', 'registry:match', 'registry:refresh'])
  })

  it('fails loudly for the registry role with no pool — the intended behaviour', async () => {
    const { buildTaskList } = await import('../src/jobs/index.js')
    const deps = {
      config: { role: 'registry' },
      db: {} as never,
      registryDb: null,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
    } as never
    expect(() => buildTaskList(deps)).toThrow(/registry-db is not configured/)
  })
})
