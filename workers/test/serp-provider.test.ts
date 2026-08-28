// The SERP provider switch, its pacing, and the cap.
//
// The pacing is not a nicety. The founder-phrasing experiment scored 1/89 on a
// burst run and 15/93 re-paced, on identical code and identical queries — the
// difference was entirely whether Google CSE, the only upstream that honours
// `site:`, was awake. A regression here looks like a bad phrasing result.

import { describe, it, expect, vi } from 'vitest'
import {
  makeSerpProvider, SearxngProvider, SerperProvider, SEARXNG_DEFAULT_INTERVAL_MS,
} from '../src/sources/serp-provider.js'

const logger = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return this },
} as never

const cfg = (over: Partial<Record<string, unknown>> = {}) => ({
  serpProvider: '',
  serperApiKey: '',
  searxngUrl: 'http://searxng:8080',
  searxngMinQueryIntervalMs: SEARXNG_DEFAULT_INTERVAL_MS,
  ...over,
}) as never

describe('makeSerpProvider — the switch', () => {
  it('uses SearXNG when no key is present', () => {
    const p = makeSerpProvider(cfg(), logger)
    expect(p?.name).toBe('searxng')
    expect(p?.minQueryIntervalMs).toBe(SEARXNG_DEFAULT_INTERVAL_MS)
    expect(p?.centsPerQuery).toBe(0)
  })

  it('uses Serper the moment a key appears — that is the whole migration', () => {
    const p = makeSerpProvider(cfg({ serperApiKey: 'k' }), logger)
    expect(p?.name).toBe('serper')
    expect(p?.minQueryIntervalMs).toBe(0)
    expect(p?.centsPerQuery).toBeGreaterThan(0)
  })

  it('SERP_PROVIDER forces either way, so an A/B needs no code change', () => {
    expect(makeSerpProvider(cfg({ serperApiKey: 'k', serpProvider: 'searxng' }), logger)?.name)
      .toBe('searxng')
    expect(makeSerpProvider(cfg({ serperApiKey: 'k', serpProvider: 'serper' }), logger)?.name)
      .toBe('serper')
  })

  it('falls back rather than booting a keyless Serper', () => {
    const warn = vi.fn()
    const noisy = {
      info() {}, warn, error() {}, debug() {}, child() { return this },
    } as never
    const p = makeSerpProvider(cfg({ serpProvider: 'serper' }), noisy)
    expect(p?.name).toBe('searxng')
    expect(warn).toHaveBeenCalled()
  })

  it('returns null when there is no backend at all', () => {
    expect(makeSerpProvider(cfg({ searxngUrl: '' }), logger)).toBeNull()
  })
})

describe('pacing', () => {
  it('serialises SearXNG queries against one clock', async () => {
    // Concurrency is what makes this necessary: serp:owner runs at
    // WORKER_CONCURRENCY, so a sleep inside one job would still let five
    // through at once.
    const p = new SearxngProvider('http://x', 40, logger)
    const at: number[] = []
    const fake = async () => { at.push(Date.now()) ; return { results: [], bytes: 0 } }
    ;(p as unknown as { fetchOnce: () => Promise<unknown> }).fetchOnce = fake

    const t0 = Date.now()
    await Promise.all([p.search('a', 1), p.search('b', 1), p.search('c', 1)])

    expect(at).toHaveLength(3)
    // Three queries at 40ms spacing cannot finish in under ~80ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75)
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(35)
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(35)
  })

  it('does not pace a paid provider', () => {
    expect(new SerperProvider('k', logger).minQueryIntervalMs).toBe(0)
  })

  it('one failed query does not poison the ones queued behind it', async () => {
    const p = new SearxngProvider('http://x', 10, logger)
    let n = 0
    ;(p as unknown as { fetchOnce: () => Promise<unknown> }).fetchOnce = async () => {
      n++
      if (n === 1) throw new Error('searxng HTTP 502')
      return { results: [], bytes: 7 }
    }

    const settled = await Promise.allSettled([p.search('a', 1), p.search('b', 1)])
    expect(settled[0].status).toBe('rejected')
    expect(settled[1].status).toBe('fulfilled')
  })
})
