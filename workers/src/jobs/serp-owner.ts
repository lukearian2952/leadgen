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
import { SerpSource, ownerQueries, resultsToText, type SerpResult } from '../sources/serp.js'
import { askJson, serpOwnerPrompt, SERP_PEOPLE_SCHEMA, usageCostCents, zeroUsage, addUsage } from '../lib/llm.js'
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

    const { rows } = await db.query<{ business_name: string; city: string }>(
      `select business_name, city from leads where id = $1`, [leadId])
    const lead = rows[0]
    if (!lead) { ctx.logger.warn('lead vanished'); return }

    if (!config.searxngUrl) {
      ctx.logger.warn('SEARXNG_URL is not set — serp:owner cannot run')
      ctx.cost.detail = { skipped: 'no_searxng_url' }
      return chain(ctx, db, campaignId, leadId)
    }

    const serp = new SerpSource(config.searxngUrl, db, ctx.logger)
    const queries = ownerQueries(lead.business_name, lead.city)

    const results: SerpResult[] = []
    let cachedQueries = 0
    for (const query of queries) {
      try {
        const got = await serp.search(query, 8)
        if (got.cached) cachedQueries++
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
      ctx.cost.detail = {
        queries: queries.length, cached_queries: cachedQueries,
        results: unique.length, candidates: 0,
        skipped: config.anthropicApiKey ? undefined : 'no_anthropic_key',
      }
      return chain(ctx, db, campaignId, leadId)
    }

    // ── extraction ────────────────────────────────────────────────────────────
    const llm = await askJson<{ people?: SerpPerson[] }>(
      config.anthropicApiKey,
      serpOwnerPrompt(lead.business_name, lead.city, resultsToText(unique)),
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

    ctx.cost.cents = usageCostCents(usage)
    ctx.cost.detail = {
      queries: queries.length,
      cached_queries: cachedQueries,
      results: unique.length,
      candidates: candidates.length,
      owner_grade: candidates.filter(c => c.nameClass === 'owner_grade').length,
      clinical_lead: candidates.filter(c => c.nameClass === 'clinical_lead').length,
      rejected,
      haiku_calls: usage.calls,
    }

    await recordSourceCost(db, campaignId, 'serp', 'serp', 1, {},
      usage.inputTokens, usage.outputTokens, ctx.cost.cents)

    await chain(ctx, db, campaignId, leadId)
  })
}

async function chain(
  ctx: JobContext, db: TaskDeps['db'], campaignId: string, leadId: string,
): Promise<void> {
  await applyNameDecision(db, leadId)
  await ctx.helpers.addJob('enrich:lead', { campaignId, leadId },
    { jobKey: jobKey('enrich:lead', campaignId, leadId), maxAttempts: 3 })
}
