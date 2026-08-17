// SERP via the self-hosted SearXNG, with a 30-day cache.
//
// SearXNG aggregates several upstreams behind one JSON endpoint — a live probe
// against the running instance returned merged brave / bing / google-cse
// results for `"Bella Fiore Med Spa" Oceanside owner` — so one request here is
// several searches, and the cache is what keeps that affordable across re-runs.
//
// ── Egress, stated rather than assumed ───────────────────────────────────────
//
// `searxng/settings.yml` configures no outbound proxy, so SearXNG's upstream
// requests leave from the server's own IP, not through Decodo. ARCHITECTURE.md
// §4E describes it as going via Decodo; it does not. That is left as it is
// here — it works, the volume is ~2 queries per lead, and rerouting a search
// aggregator's egress mid-phase is a change with its own failure modes — but
// it is a real difference between the design and the deployment, and it is the
// thing to change first if the upstreams start returning captchas.
//
// The worker→SearXNG hop itself is container-internal and needs no proxy.

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { httpFetch } from '../net.js'
import type { Logger } from '../logger.js'

export interface SerpResult {
  title: string
  url: string
  content: string
  engine: string
}

/** The brief's cache lifetime. */
export const CACHE_DAYS = 30

export class SerpSource {
  readonly name = 'serp'

  constructor(
    private readonly baseUrl: string,
    private readonly db: Pool,
    private readonly logger: Logger,
  ) {}

  /**
   * Run a query, or return the cached results if they are inside the window.
   *
   * Returns `{ results, cached }` so callers can report cache hit rate — the
   * number that says whether a re-run cost anything.
   */
  async search(query: string, maxResults = 10): Promise<{ results: SerpResult[]; cached: boolean }> {
    const hash = queryHash(query)

    const { rows } = await this.db.query<{ results: SerpResult[] }>(
      `select results from serp_cache
        where query_hash = $1 and fetched_at > now() - ($2 || ' days')::interval`,
      [hash, CACHE_DAYS])

    if (rows[0]) {
      await this.db.query(
        `update serp_cache set hit_count = hit_count + 1 where query_hash = $1`, [hash])
      return { results: (rows[0].results ?? []).slice(0, maxResults), cached: true }
    }

    const results = await this.fetch(query, maxResults)

    await this.db.query(
      `insert into serp_cache (query_hash, query, engine, results, fetched_at)
       values ($1,$2,'searxng',$3::jsonb, now())
       on conflict (query_hash) do update
         set results = excluded.results, fetched_at = now(), hit_count = 0`,
      [hash, query, JSON.stringify(results)])

    return { results, cached: false }
  }

  private async fetch(query: string, maxResults: number): Promise<SerpResult[]> {
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
    if (!res.ok) {
      throw new Error(`searxng HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }

    const body = await res.json() as { results?: Array<Record<string, unknown>> }
    return (body.results ?? []).slice(0, maxResults).map(r => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      content: String(r.content ?? ''),
      engine: String(r.engine ?? ''),
    }))
  }
}

export function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 40)
}

/**
 * The two queries from the brief.
 *
 * The first asks the open web who runs the business. The second is aimed at
 * LinkedIn, which is where titled owners actually are, without touching
 * LinkedIn itself — a `site:` query returns the profile's public title from
 * the search index, which is all the name extraction needs and none of the
 * account risk Phase 4 will have to take on.
 */
export function ownerQueries(businessName: string, town: string): string[] {
  const name = businessName.replace(/"/g, '').trim()
  const where = (town ?? '').trim()
  return [
    `"${name}"${where ? ` ${where}` : ''} owner OR founder`,
    `site:linkedin.com/in "${name}"`,
  ]
}

/** Compact the results into the block handed to the model. */
export function resultsToText(results: readonly SerpResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n')
    .slice(0, 8000)
}
