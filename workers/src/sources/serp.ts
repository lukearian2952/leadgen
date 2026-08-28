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
 * The two queries from the brief — the brick-and-mortar phrasing.
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

/**
 * The online/SaaS phrasing.
 *
 * Measured cause, not a guess: over the 93 unnamed SaaS leads of campaign
 * 0880d44f the brick-and-mortar queries produced **zero** accepted candidates
 * — 85 model calls, 4 people returned in total. Three things are wrong with
 * them for a company with no storefront:
 *
 *   - "owner" is not the word a software company uses about itself. Its people
 *     are founders, co-founders and CEOs, and the pages that say so are press
 *     releases and funding announcements.
 *   - A bare company name against `linkedin.com/in` ranks *employees*, who are
 *     numerous, above the two founders, who are not. Naming the title in the
 *     query is what moves the founder to the top of the index.
 *   - Neither query asks the vendor's own site who founded it, and an "our
 *     story" page states it in prose that the crawl's people-extraction, which
 *     is looking for name/title pairs in a team grid, reads straight past.
 *
 * The `site:` query is scoped to the vendor's own domain when we know it —
 * unscoped it competes with the whole web for a generic word like "about".
 */
export function founderQueries(
  businessName: string, website?: string | null,
): string[] {
  const name = businessName.replace(/"/g, '').trim()
  const queries = [
    `"${name}" founder OR CEO OR "co-founder" site:linkedin.com/in`,
    `"${name}" "founded by" OR "our story"`,
  ]

  const domain = websiteDomain(website)
  if (domain) queries.push(`site:${domain} about OR team OR leadership`)

  return queries
}

/** Bare hostname for a `site:` query, or null when there is nothing usable. */
export function websiteDomain(website?: string | null): string | null {
  const raw = (website ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`)
      .hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** Compact the results into the block handed to the model. */
export function resultsToText(results: readonly SerpResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n')
    .slice(0, 8000)
}
