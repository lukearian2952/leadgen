// serp:owner — ask the open web who runs this business.
//
// Last of the three naming sources and the only one that reads what *other*
// people say, which is both its value and its risk. The site is the business's
// own copy and the registry is its own filing; SERP is the only place a
// third-party "X, owner of Y" can come from, and it is also the only place a
// confident, real, completely wrong name can come from — search results for
// "Radiance Med Spa owner" will cheerfully return the owner of a different
// Radiance Med Spa in Ohio.
//
// Three guards, all of which have to hold:
//
//   1. The model is told the town and instructed to reject results it cannot
//      tie to this business at this location.
//   2. The `source_url` it copies must be one of the URLs we actually passed
//      in — the cheapest available check that it read rather than recalled.
//   3. Per the brief, a SERP name is only accepted when it is owner-grade, or
//      when it is clinical_lead and a second source already agrees. That last
//      rule is enforced by decideName, not here, so SERP candidates are
//      recorded even when they will not win.
//
// Cost control is the 30-day `serp_cache` plus the fact that this stage only
// runs for leads registry:match decided it could help — a lead with an
// owner-grade name already never gets here.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey, type JobContext } from './wrap.js'
import type { TaskDeps } from './index.js'
import { SerpSource, ownerQueries, founderQueries, websiteDomain, resultsToText, type SerpResult } from '../sources/serp.js'
import { makeSerpProvider } from '../sources/serp-provider.js'
import { askJson, serpOwnerPrompt, serpFounderPrompt, SERP_PEOPLE_SCHEMA, usageCostCents, zeroUsage, addUsage } from '../lib/llm.js'
import { resolveNicheFilter } from '../lib/niche-types.js'
import { parseName } from '../lib/identity.js'
import { classifyPerson } from '../lib/name-class.js'
import { putCandidates, applyNameDecision } from './name-store.js'
import type { NameCandidate } from '../lib/name-decision.js'
import { recordSourceCost } from './crawl-site.js'

interface Payload { campaignId: string; leadId: string; [key: string]: unknown }

interface SerpPerson {
  full_name?: string
  title?: string
  source_url?: string
  confidence?: string
}

const CONFIDENCE_SCORE: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 }

export function makeSerpOwnerTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'serp:owner', db }, async (payload, ctx) => {
    const { campaignId, leadId } = payload

    const { rows } = await db.query<{ business_name: string; city: string; website: string | null }>(
      `select business_name, city, website from leads where id = $1`, [leadId])
    const lead = rows[0]
    if (!lead) { ctx.logger.warn('lead vanished'); return }

    // Which phrasing? `resolveNicheFilter` sets `serp` only in its no-rule
    // fallback, and every rule in niche-types is a brick-and-mortar trade — so
    // `serp === true` is exactly the online/SaaS case. The same discriminator
    // registry:match already uses to decide whether to run this stage at all.
    const { rows: cRows } = await db.query<{ niche: string }>(
      `select niche from campaigns where id = $1`, [campaignId])
    const online = resolveNicheFilter(cRows[0]?.niche ?? '').serp
    const domain = websiteDomain(lead.website)

    const provider = makeSerpProvider(config, ctx.logger)
    if (!provider) {
      ctx.logger.warn('no SERP provider configured — serp:owner cannot run')
      ctx.cost.detail = { skipped: 'no_serp_provider' }
      return chain(ctx, db, campaignId, leadId)
    }

    // ── the paid-provider cap ────────────────────────────────────────────────
    //
    // Serper has no rate ceiling of its own, which is the point of paying for
    // it and also the risk: a 1,000-lead campaign at three queries each is
    // 3,000 queries nobody approved. `source_costs` already accumulates units
    // per campaign atomically, so the spend counter and the cap read the same
    // row. SearXNG is uncapped because it is free and paced instead.
    if (provider.centsPerQuery > 0) {
      const { rows: [spent] } = await db.query<{ units: number }>(
        `select coalesce(sum(units),0)::int units from source_costs
          where campaign_id = $1 and source = 'serp_queries'`, [campaignId])
      if ((spent?.units ?? 0) >= config.serperMaxQueriesPerCampaign) {
        ctx.logger.warn('serp query cap reached for this campaign', {
          campaignId, cap: config.serperMaxQueriesPerCampaign, spent: spent?.units,
        })
        await putCandidates(db, leadId, 'serp', [])
        ctx.cost.detail = {
          provider: provider.name, skipped: 'query_cap',
          cap: config.serperMaxQueriesPerCampaign, spent: spent?.units ?? 0,
        }
        return chain(ctx, db, campaignId, leadId)
      }
    }

    const serp = new SerpSource(provider, db, ctx.logger)
    const queries = online
      ? founderQueries(lead.business_name, lead.website)
      : ownerQueries(lead.business_name, lead.city)

    const results: SerpResult[] = []
    let cachedQueries = 0, liveQueries = 0, serpBytes = 0
    for (const query of queries) {
      try {
        const got = await serp.search(query, 8)
        if (got.cached) cachedQueries++; else liveQueries++
        serpBytes += got.bytes
        results.push(...got.results)
      } catch (err) {
        // One failing query must not lose the other's results, and a SERP
        // outage must not fail the lead — it just means no SERP name.
        ctx.logger.warn('serp query failed', { query, err: (err as Error).message })
      }
    }

    const seenUrl = new Set<string>()
    const unique = results.filter(r => r.url && !seenUrl.has(r.url) && seenUrl.add(r.url))

    if (!unique.length || !config.anthropicApiKey) {
      await putCandidates(db, leadId, 'serp', [])
      // Metered even when nothing came back: queries that returned nothing are
      // exactly the ones a cap and a byte budget need to know about.
      await meterSerp(db, campaignId, provider.name, liveQueries, serpBytes,
        liveQueries * provider.centsPerQuery)
      ctx.cost.cents = liveQueries * provider.centsPerQuery
      ctx.cost.detail = {
        provider: provider.name,
        queries: queries.length, live_queries: liveQueries,
        cached_queries: cachedQueries, serp_bytes: serpBytes,
        results: unique.length, candidates: 0,
        skipped: config.anthropicApiKey ? undefined : 'no_anthropic_key',
      }
      return chain(ctx, db, campaignId, leadId)
    }

    // ── extraction ────────────────────────────────────────────────────────────
    const llm = await askJson<{ people?: SerpPerson[] }>(
      config.anthropicApiKey,
      online
        ? serpFounderPrompt(lead.business_name, domain ?? '', resultsToText(unique))
        : serpOwnerPrompt(lead.business_name, lead.city, resultsToText(unique)),
      SERP_PEOPLE_SCHEMA, 1200,
    )
    const usage = addUsage(zeroUsage(), llm.usage)
    if (llm.error) ctx.logger.warn('serp extraction failed', { err: llm.error })

    const allowedUrls = new Set(unique.map(r => r.url))
    const candidates: NameCandidate[] = []
    const rejected: Array<{ name: string; why: string }> = []

    for (const person of llm.data?.people ?? []) {
      const raw = (person.full_name ?? '').trim()
      if (!raw) continue

      // The URL check. A model that could not point at a result it was given
      // did not read one.
      const url = (person.source_url ?? '').trim()
      if (!allowedUrls.has(url)) {
        rejected.push({ name: raw, why: 'source_url_not_in_results' })
        continue
      }

      const parsed = parseName(raw)
      if (parsed.reject) { rejected.push({ name: raw, why: parsed.reject }); continue }

      const title = (person.title ?? '').trim()
      const nameClass = classifyPerson(raw, title)
      if (nameClass === 'staff') { rejected.push({ name: raw, why: 'title_staff' }); continue }

      candidates.push({
        source: 'serp',
        first: parsed.first,
        last: parsed.last,
        title,
        nameClass,
        confidence: CONFIDENCE_SCORE[(person.confidence ?? 'low').toLowerCase()] ?? 0.3,
        detail: { source_url: url, raw_name: raw, model_confidence: person.confidence ?? null },
      })
    }

    await putCandidates(db, leadId, 'serp', candidates)

    const queryCents = liveQueries * provider.centsPerQuery
    ctx.cost.cents = usageCostCents(usage) + queryCents
    ctx.cost.detail = {
      provider: provider.name,
      phrasing: online ? 'founder' : 'owner',
      queries: queries.length,
      live_queries: liveQueries,
      serp_bytes: serpBytes,
      cached_queries: cachedQueries,
      results: unique.length,
      candidates: candidates.length,
      owner_grade: candidates.filter(c => c.nameClass === 'owner_grade').length,
      clinical_lead: candidates.filter(c => c.nameClass === 'clinical_lead').length,
      rejected,
      haiku_calls: usage.calls,
    }

    await meterSerp(db, campaignId, provider.name, liveQueries, serpBytes, queryCents)
    // The per-lead row stays as it was, minus the query cost now booked above,
    // so `serp` remains "what naming this lead cost in model tokens".
    await recordSourceCost(db, campaignId, 'serp', 'serp', 1, {},
      usage.inputTokens, usage.outputTokens, usageCostCents(usage))

    await chain(ctx, db, campaignId, leadId)
  })
}

/**
 * Book SERP traffic against the campaign.
 *
 * Two rows, deliberately. `serp` counts *leads* and carries the model cost;
 * `serp_queries` counts *queries* and carries the transport cost and bytes,
 * because the paid-provider cap is a query budget and one lead is three
 * queries. Reading a query count off a per-lead row was how SERP stayed
 * unmetered — HANDOFF §7.3.
 *
 * The bytes are what the worker received, not SearXNG's own upstream
 * residential usage, which leaves the box without passing through ProxyPool and
 * still is not visible from here.
 */
async function meterSerp(
  db: TaskDeps['db'], campaignId: string, provider: string,
  liveQueries: number, bytes: number, cents: number,
): Promise<void> {
  if (!liveQueries && !bytes) return
  await db.query(
    `select add_source_cost($1,$2,$3,$4,$5,$6,$7,$8)`,
    [campaignId, 'serp_queries', `serp:${provider}`, liveQueries, bytes, 0, 0, cents])
}

async function chain(
  ctx: JobContext, db: TaskDeps['db'], campaignId: string, leadId: string,
): Promise<void> {
  await applyNameDecision(db, leadId)
  await ctx.helpers.addJob('enrich:lead', { campaignId, leadId },
    { jobKey: jobKey('enrich:lead', campaignId, leadId), maxAttempts: 3 })
}
