// SERP querying: the cache, the query shapes, and the text handed to the model.
//
// The transport lives in `serp-provider.ts` — SearXNG or Serper behind one
// interface — because the self-hosted instance has a measured throughput
// ceiling that is worth being able to pay to remove. Read that file's header
// before changing anything about how often this is called.

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import type { SerpProvider, SerpResult } from './serp-provider.js'

export type { SerpResult } from './serp-provider.js'

/** The brief's cache lifetime. */
export const CACHE_DAYS = 30

export interface SearchOutcome {
  results: SerpResult[]
  cached: boolean
  /** Response bytes for an uncached query; 0 for a cache hit. */
  bytes: number
}

export class SerpSource {
  readonly name = 'serp'

  constructor(
    private readonly provider: SerpProvider,
    private readonly db: Pool,
    private readonly logger: Logger,
  ) {}

  /** Which backend answered, for the run's cost detail. */
  get providerName(): string { return this.provider.name }

  /**
   * Run a query, or return the cached results if they are inside the window.
   *
   * Returns `cached` so callers can report hit rate — the number that says
   * whether a re-run cost anything — and `bytes` so SERP stops being the one
   * stage whose traffic never reaches `source_costs`.
   *
   * The cache is keyed on the query alone, deliberately: swapping provider does
   * not invalidate it, because the question asked has not changed. A run that
   * needs fresh answers from a new provider clears the rows first, as the
   * phrasing experiment did.
   */
  async search(query: string, maxResults = 10): Promise<SearchOutcome> {
    const hash = queryHash(query)

    const { rows } = await this.db.query<{ results: SerpResult[] }>(
      `select results from serp_cache
        where query_hash = $1 and fetched_at > now() - ($2 || ' days')::interval`,
      [hash, CACHE_DAYS])

    if (rows[0]) {
      await this.db.query(
        `update serp_cache set hit_count = hit_count + 1 where query_hash = $1`, [hash])
      return { results: (rows[0].results ?? []).slice(0, maxResults), cached: true, bytes: 0 }
    }

    const got = await this.provider.search(query, maxResults)

    await this.db.query(
      `insert into serp_cache (query_hash, query, engine, results, fetched_at)
       values ($1,$2,$3,$4::jsonb, now())
       on conflict (query_hash) do update
         set results = excluded.results, engine = excluded.engine,
             fetched_at = now(), hit_count = 0`,
      [hash, query, this.provider.name, JSON.stringify(got.results)])

    return { results: got.results, cached: false, bytes: got.bytes }
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
