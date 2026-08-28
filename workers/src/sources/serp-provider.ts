// The SERP provider interface, and its two implementations.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The founder-phrasing experiment measured 16.1% owner-grade candidates on the
// SaaS cohort, but only after the run was re-paced to one lead every 50
// seconds. The first attempt scored 1 in 89, and the reason was entirely
// infrastructural:
//
//   `site:linkedin.com/in` is honoured by exactly one of the upstreams SearXNG
//   aggregates. Bing discards the operator silently and answers with the
//   company's own domain — 2,040 results carrying 3 LinkedIn URLs. Google CSE
//   honours it — 89 results carrying 17 — but answers about nine queries before
//   suspending itself for roughly two minutes.
//
// So the self-hosted instance has a real throughput ceiling of ~3.6 queries a
// minute, and exceeding it does not fail loudly: SearXNG still returns 200 with
// a `results` array, just one assembled from the engine that ignored half the
// query. **A SERP number taken from a burst run is not a measurement.**
//
// That ceiling is a property of the free upstream, not of the phrasing, so it
// is worth being able to pay to remove. This interface lets `serp:owner` run
// unchanged against either:
//
//   searxng   self-hosted, free, paced to what Google CSE tolerates
//   serper    api key, no pacing, capped per campaign so it cannot run away
//
// Selection is by presence of SERPER_API_KEY, so adding the key to `.env` is
// the whole migration and removing it is the whole rollback.

import type { Logger } from '../logger.js'
import { httpFetch } from '../net.js'

export interface SerpResult {
  title: string
  url: string
  content: string
  engine: string
}

export interface ProviderResponse {
  results: SerpResult[]
  /** Response bytes, so SERP stops being the one unmetered stage. */
  bytes: number
}

export interface SerpProvider {
  readonly name: string
  /**
   * Minimum spacing between queries, enforced process-wide.
   *
   * Zero for a paid API. For SearXNG this is the measured Google CSE budget —
   * see the header — and it is the difference between a 16.1% result and a 1%
   * one.
   */
  readonly minQueryIntervalMs: number
  /** Cents per query, for source_costs. Zero for the self-hosted instance. */
  readonly centsPerQuery: number
  search(query: string, maxResults: number): Promise<ProviderResponse>
}

/**
 * Process-wide spacing.
 *
 * `serp:owner` runs at WORKER_CONCURRENCY (5 by default), so a `sleep` inside
 * one job would still let five run in parallel and produce five times the
 * intended rate. Chaining on a shared promise serialises every caller in the
 * process against one clock, and only serp-worker registers this stage, so the
 * process is the whole fleet for this purpose.
 */
class Pacer {
  private tail: Promise<void> = Promise.resolve()
  private last = 0

  constructor(private readonly intervalMs: number) {}

  next<T>(fn: () => Promise<T>): Promise<T> {
    if (this.intervalMs <= 0) return fn()
    const run = this.tail.then(async () => {
      const wait = this.last + this.intervalMs - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      this.last = Date.now()
    })
    // The tail must not reject-chain: one failed query would otherwise poison
    // every query queued behind it.
    this.tail = run.catch(() => {})
    return run.then(fn)
  }
}

// ── SearXNG ─────────────────────────────────────────────────────────────────

/**
 * ~16.7s between queries.
 *
 * Google CSE answered nine queries and then reported itself unresponsive for
 * about two minutes — call it nine per 150s. Three queries per lead at this
 * spacing is the 50s-per-lead cadence the 16.1% figure was measured at.
 */
export const SEARXNG_DEFAULT_INTERVAL_MS = 16_700

export class SearxngProvider implements SerpProvider {
  readonly name = 'searxng'
  readonly centsPerQuery = 0
  private readonly pacer: Pacer

  constructor(
    private readonly baseUrl: string,
    readonly minQueryIntervalMs: number,
    private readonly logger: Logger,
  ) {
    this.pacer = new Pacer(minQueryIntervalMs)
  }

  search(query: string, maxResults: number): Promise<ProviderResponse> {
    return this.pacer.next(() => this.fetchOnce(query, maxResults))
  }

  private async fetchOnce(query: string, maxResults: number): Promise<ProviderResponse> {
    const url = new URL('/search', this.baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', 'en-US')
    // General category only: image and news verticals add latency and never
    // carry an owner's name.
    url.searchParams.set('categories', 'general')

    const res = await httpFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(45_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`searxng HTTP ${res.status} ${text.slice(0, 200)}`)
    }

    const body = JSON.parse(text) as {
      results?: Array<Record<string, unknown>>
      unresponsive_engines?: unknown[]
    }

    // The engine that honours `site:` going quiet is the failure this whole
    // file exists to make visible, so it is logged rather than swallowed.
    const down = (body.unresponsive_engines ?? [])
      .map(e => (Array.isArray(e) ? String(e[0]) : String(e)))
    if (down.includes('google cse')) {
      this.logger.warn('google cse is unresponsive — site: operators will be ignored', {
        query: query.slice(0, 80), unresponsive: down,
      })
    }

    return {
      results: (body.results ?? []).slice(0, maxResults).map(toResult),
      bytes: Buffer.byteLength(text),
    }
  }
}

// ── Serper ──────────────────────────────────────────────────────────────────

export class SerperProvider implements SerpProvider {
  readonly name = 'serper'
  readonly minQueryIntervalMs = 0
  /** Serper's credit pricing is ~$1 per 1,000 queries on the paid tiers. */
  readonly centsPerQuery = 0.1

  constructor(private readonly apiKey: string, private readonly logger: Logger) {}

  async search(query: string, maxResults: number): Promise<ProviderResponse> {
    const res = await httpFetch(new URL('https://google.serper.dev/search'), {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: Math.min(maxResults, 10) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`serper HTTP ${res.status} ${text.slice(0, 200)}`)

    const body = JSON.parse(text) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>
    }

    return {
      results: (body.organic ?? []).slice(0, maxResults).map(r => ({
        title: String(r.title ?? ''),
        url: String(r.link ?? ''),
        content: String(r.snippet ?? ''),
        engine: 'serper',
      })),
      bytes: Buffer.byteLength(text),
    }
  }
}

function toResult(r: Record<string, unknown>): SerpResult {
  return {
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    content: String(r.content ?? ''),
    engine: String(r.engine ?? ''),
  }
}

/**
 * Pick a provider from config.
 *
 * Presence of the key is the switch. `SERP_PROVIDER` can force one either way,
 * which is what makes an A/B on the same box possible without editing code.
 */
export function makeSerpProvider(
  cfg: {
    serpProvider: string
    serperApiKey: string
    searxngUrl: string
    searxngMinQueryIntervalMs: number
  },
  logger: Logger,
): SerpProvider | null {
  const forced = (cfg.serpProvider ?? '').trim().toLowerCase()
  const wantSerper = forced === 'serper' || (!forced && !!cfg.serperApiKey)

  if (wantSerper) {
    if (!cfg.serperApiKey) {
      logger.warn('SERP_PROVIDER=serper but SERPER_API_KEY is empty — falling back to searxng')
    } else {
      return new SerperProvider(cfg.serperApiKey, logger)
    }
  }
  if (!cfg.searxngUrl) return null
  return new SearxngProvider(cfg.searxngUrl, cfg.searxngMinQueryIntervalMs, logger)
}
