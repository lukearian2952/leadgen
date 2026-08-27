// saas:discover — turn an online/SaaS niche into `leads` rows from search.
//
// The counterpart to `maps:discover` for niches that have no storefront. A
// practice-management SaaS has no Google Maps listing worth having, so the
// Maps path returns either nothing or the wrong thing — a medical office that
// happens to match the words.
//
// Discovery here is search: `sources/saas.ts` explains why it is search and not
// a G2/Capterra/ProductHunt/YC crawler (all four checked live; two are behind
// Cloudflare challenges, one challenges its own robots.txt, and YC's API is
// `Disallow: /`).
//
// ── What it does not do ──────────────────────────────────────────────────────
//
// It does not batch or self-chain the way `maps:discover` does. That machinery
// exists because gosom falls over past a few dozen concurrent Maps searches;
// this stage issues **five** cached SERP queries for a whole campaign, so there
// is nothing to spread out. If a future niche needs hundreds of queries, copy
// the batching from `maps:discover` rather than growing this one.
//
// Everything downstream is unchanged: each candidate gets a `crawl:site` job
// and joins the existing crawl → registry:match → [serp:owner] → enrich:lead
// chain.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey } from './wrap.js'
import type { TaskDeps } from './index.js'
import { makeSaasDiscovery } from '../sources/saas.js'
import { normaliseName } from '../lib/normalise.js'
import { isJunkDomain } from '../lib/identity.js'

interface Payload {
  campaignId: string
  niche: string
  location: string
  targetCount?: number
  [key: string]: unknown
}

/**
 * Domains that must appear under at least this many distinct queries.
 *
 * 1 admits everything the engines returned, including the blog that mentioned a
 * competitor once. It is left at 1 deliberately: the crawl and the gate are
 * what reject a non-vendor, and they are better at it than a hit count, while
 * raising this would silently drop small vendors that only rank for one phrase.
 * Recorded on the lead so the trade-off can be measured rather than argued.
 */
const MIN_QUERY_HITS = 1

export function makeSaasDiscoverTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'saas:discover', db }, async (payload, ctx) => {
    const { campaignId, niche, location } = payload
    const targetCount = payload.targetCount ?? 100

    if (!config.searxngUrl) {
      throw new Error(
        'saas:discover needs SEARXNG_URL. Search is the only discovery channel ' +
        'for an online niche — see sources/saas.ts for why the directories are not.')
    }

    const discovery = makeSaasDiscovery(config.searxngUrl, db, ctx.logger)
    const { candidates, queries, cachedQueries } =
      await discovery.discover(niche, location)

    ctx.logger.info('saas discovery returned', {
      niche, location, queries: queries.length, cachedQueries,
      candidates: candidates.length,
    })

    // Domains this campaign already holds. Discovery may be re-run — a
    // re-crawl is cheap, a duplicate lead is not: it double-counts in every
    // funnel number the campaign reports.
    const { rows: existingRows } = await db.query<{ domain: string }>(
      `select distinct coalesce(b.domain, '') domain
         from leads l join businesses b on b.id = l.business_id
        where l.campaign_id = $1 and coalesce(b.domain,'') <> ''`, [campaignId])
    const seen = new Set(existingRows.map(r => r.domain))

    // `targetCount` is a ceiling on the **campaign**, not on this run. Capping
    // per run instead let a second discovery pass take a campaign of 49 to 149
    // against a target of 100 — every funnel percentage then has a denominator
    // nobody asked for.
    const { rows: [held] } = await db.query<{ n: string }>(
      `select count(*) n from leads where campaign_id = $1`, [campaignId])
    const room = Math.max(0, targetCount - Number(held.n))
    if (room === 0) {
      ctx.logger.info('saas discovery: campaign already at target', {
        campaignId, targetCount, held: Number(held.n),
      })
    }

    let inserted = 0
    let skippedDuplicate = 0
    let skippedThin = 0

    for (const candidate of candidates) {
      if (inserted >= room) break
      if (seen.has(candidate.domain)) { skippedDuplicate++; continue }
      if (candidate.hits < MIN_QUERY_HITS) { skippedThin++; continue }
      if (isJunkDomain(candidate.domain)) { skippedThin++; continue }
      seen.add(candidate.domain)

      const { rows } = await db.query<{ id: string }>(
        `insert into businesses
           (domain, name, name_norm, website, country, category, sources, evidence,
            last_seen_at)
         values ($1,$2,$3,$4,$5,$6,array['saas_serp'],$7,now())
         on conflict (domain) where domain is not null and domain <> ''
         do update set last_seen_at = now()
         returning id`,
        [candidate.domain, candidate.name, normaliseName(candidate.name),
         candidate.website, location, niche,
         JSON.stringify({
           serp_hits: candidate.hits,
           serp_title: candidate.sampleTitle,
           serp_url: candidate.sampleUrl,
         })])

      const businessId = rows[0]?.id ?? null

      const { rows: leadRows } = await db.query<{ id: string }>(
        `insert into leads
           (campaign_id, business_id, business_name, website, country, category,
            sources, evidence)
         values ($1,$2,$3,$4,$5,$6,array['saas_serp'],$7)
         returning id`,
        [campaignId, businessId, candidate.name, candidate.website, location, niche,
         JSON.stringify({
           discovery: 'saas_serp',
           serp_hits: candidate.hits,
           serp_title: candidate.sampleTitle,
           serp_url: candidate.sampleUrl,
         })])

      inserted++

      await ctx.helpers.addJob('crawl:site', {
        campaignId, leadId: leadRows[0].id,
        website: candidate.website, domain: candidate.domain,
        businessName: candidate.name,
      }, { jobKey: jobKey('crawl:site', campaignId, leadRows[0].id), maxAttempts: 3 })
    }

    // Same bookkeeping `maps:discover` writes, so the UI and `campaign:reconcile`
    // do not need to know which discovery stage ran.
    const { rows: [total] } = await db.query<{ n: string }>(
      `select count(*) n from leads where campaign_id = $1`, [campaignId])
    await db.query(
      `update campaigns set step1_done = $2, current_step = 2 where id = $1`,
      [campaignId, Number(total.n)])

    ctx.cost.detail = {
      niche, location,
      queries: queries.length,
      cached_queries: cachedQueries,
      candidates: candidates.length,
      inserted,
      already_held: Number(held.n),
      room,
      skipped_duplicate: skippedDuplicate,
      skipped_thin: skippedThin,
      // The hit-count distribution says whether MIN_QUERY_HITS is worth
      // raising. Kept as data rather than tuned blind.
      hits_histogram: histogram(candidates.map(c => c.hits)),
    }
    ctx.logger.info('saas discovery complete', ctx.cost.detail)
  })
}

function histogram(values: number[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1
  return out
}
