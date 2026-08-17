// crawl:site — read the business's own website and find the human behind it.
//
// Datacenter first, residential only on a blocking signal (your Phase 2
// policy). Per-pool bytes land in job_runs so the cost split is measured, not
// estimated.
//
// One Haiku call per lead, max. The model only runs when the crawl produced
// enough text to be worth reading, and every name it returns must appear in the
// page text — a name the site never mentions is a hallucination, and
// "Hi {hallucinated}," is the failure this pipeline exists to prevent.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey, type JobContext } from './wrap.js'
import type { TaskDeps } from './index.js'
import { CrawlSource, nameAppearsInText } from '../sources/crawl.js'
import { ProxyPool } from '../proxy/pool.js'
import { askJson, peoplePrompt, PEOPLE_SCHEMA, usageCostCents, zeroUsage, addUsage } from '../lib/llm.js'
import {
  parseName, isGenericLocalPart, isJunkDomain,
  emailDomain, isValidEmail,
} from '../lib/identity.js'
import { classifyPerson, hasOwnershipVoice } from '../lib/name-class.js'
import { putCandidates, putSiteSignals } from './name-store.js'
import type { NameCandidate } from '../lib/name-decision.js'

interface Payload {
  campaignId: string
  leadId: string
  website: string
  domain: string
  businessName: string
  [key: string]: unknown
}

export function makeCrawlSiteTask(deps: TaskDeps): Task {
  const { config, db } = deps
  const pool = new ProxyPool(config)

  return wrapTask<Payload>({ stage: 'crawl:site', db }, async (payload, ctx) => {
    const { campaignId, leadId, website, domain, businessName } = payload
    const crawler = new CrawlSource(pool, ctx.logger)

    const result = await crawler.crawl(website)
    let usage = zeroUsage()

    const evidence: Record<string, unknown> = {
      crawl_pages: result.pages.map(p => ({ url: p.url, status: p.status, pool: p.pool })),
      crawl_escalated: result.escalated,
      crawl_emails: result.emails.slice(0, 10),
    }

    if (!result.pages.length) {
      await db.query(
        `update leads set crawl_done = true, evidence = evidence || $2::jsonb where id = $1`,
        [leadId, JSON.stringify({ ...evidence, crawl_error: result.error ?? 'no pages' })])
      await putSiteSignals(db, leadId, { peopleNamedOnSite: 0, ownershipVoice: false })
      await putCandidates(db, leadId, 'site_crawl', [])
      await queueRegistry(ctx, campaignId, leadId)
      ctx.cost.detail = { pages: 0, error: result.error, bytes_by_pool: result.bytesByPool }
      return
    }

    // ── general inbox ─────────────────────────────────────────────────────────
    // Role addresses are recorded but never treated as owner contacts: they
    // reach a front desk, and v1 shipped 43% of its export as info@.
    const onDomain = result.emails.filter(e =>
      isValidEmail(e) && !isJunkDomain(emailDomain(e)))
    const generalEmail = onDomain.find(e => isGenericLocalPart(e)) ?? ''
    const personalEmail = onDomain.find(e => !isGenericLocalPart(e)) ?? ''

    // ── people ────────────────────────────────────────────────────────────────
    //
    // Phase 2 took the first owner-titled person and dropped everyone else.
    // The audit showed what that cost: 21 of 75 leads had a real person on
    // their own site and were discarded because "board-certified Nurse
    // Practitioner" is not an ownership claim.
    //
    // Now every corroborated person is kept as a candidate with a class, and
    // whether a clinical_lead is usable is decided later, once the registry
    // and SERP have had their say. This stage's job is to observe, not to
    // judge.
    const candidates: NameCandidate[] = []
    let isDoctor = false
    /** Distinct people the site names at all — the denominator for the
     *  sole-person-on-site corroboration. Counted before classification, so a
     *  site listing six estheticians is correctly "six people, not one". */
    let peopleNamedOnSite = 0

    if (config.anthropicApiKey && result.text.length > 200) {
      const llm = await askJson<{ people?: Array<{ full_name?: string; title?: string; confidence?: string }> }>(
        config.anthropicApiKey,
        peoplePrompt(businessName, result.text),
        PEOPLE_SCHEMA, 1500,
      )
      usage = addUsage(usage, llm.usage)
      if (llm.error) ctx.logger.warn('haiku extraction failed', { err: llm.error })

      const people = llm.data?.people ?? []
      evidence.people_found = people.slice(0, 8)

      const seen = new Set<string>()
      for (const person of people) {
        const parsed = parseName(person.full_name ?? '')
        if (parsed.reject) continue
        // Corroboration: the page must actually contain the name. Without this
        // the model will invent a plausible owner for any business.
        if (!nameAppearsInText(parsed.first, parsed.last, result.text)) {
          evidence.rejected_uncorroborated = person.full_name
          continue
        }

        const key = `${parsed.first}|${parsed.last}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        peopleNamedOnSite++

        const title = (person.title ?? '').trim()
        const nameClass = classifyPerson(person.full_name ?? '', title)
        if (nameClass === 'staff') continue

        if (parsed.isDoctor) isDoctor = true
        candidates.push({
          source: 'site_crawl',
          first: parsed.first, last: parsed.last, title, nameClass,
          confidence: person.confidence === 'high' ? 0.9
                    : person.confidence === 'medium' ? 0.6 : 0.3,
          detail: { raw_name: person.full_name ?? '', model_confidence: person.confidence ?? null },
        })
      }
    }

    // The other half of the sole-person test. Cheap, and only ever consulted
    // when exactly one person was named.
    const ownershipVoice = hasOwnershipVoice(result.text)

    evidence.site_people_count = peopleNamedOnSite
    evidence.site_ownership_voice = ownershipVoice
    evidence.site_candidates = candidates.map(c => ({
      name: [c.first, c.last].filter(Boolean).join(' '), title: c.title, name_class: c.nameClass,
    }))

    await db.query(
      `update leads
          set crawl_done = true,
              is_doctor  = $2 or is_doctor,
              email      = coalesce(nullif($3,''), email),
              sources    = array(select distinct unnest(sources || array['site_crawl'])),
              evidence   = evidence || $4::jsonb
        where id = $1`,
      [leadId, isDoctor, generalEmail || personalEmail, JSON.stringify(evidence)])

    await putSiteSignals(db, leadId, { peopleNamedOnSite, ownershipVoice })
    await putCandidates(db, leadId, 'site_crawl', candidates)

    // A personal-looking address already on the site is the strongest possible
    // candidate: it needs no pattern guess, only verification.
    if (personalEmail) {
      await db.query(
        `insert into contacts (campaign_id, lead_id, email, email_kind, sources, evidence)
         values ($1,$2,$3,'owner',array['site_crawl'],$4)
         on conflict (campaign_id, email) where email <> '' do nothing`,
        [campaignId, leadId, personalEmail,
         JSON.stringify({ found_on: 'site', pages: result.pages.length })])
    }

    ctx.cost.cents = usageCostCents(usage)
    ctx.cost.detail = {
      pages: result.pages.length,
      bytes_by_pool: result.bytesByPool,
      escalated: result.escalated,
      people_on_site: peopleNamedOnSite,
      ownership_voice: ownershipVoice,
      candidates: candidates.length,
      owner_grade: candidates.filter(c => c.nameClass === 'owner_grade').length,
      clinical_lead: candidates.filter(c => c.nameClass === 'clinical_lead').length,
      emails_found: onDomain.length,
      haiku_calls: usage.calls,
      haiku_input_tokens: usage.inputTokens,
      haiku_output_tokens: usage.outputTokens,
    }

    await recordSourceCost(db, campaignId, 'site_crawl', 'crawl',
      1, result.bytesByPool, usage.inputTokens, usage.outputTokens, ctx.cost.cents)

    await queueRegistry(ctx, campaignId, leadId)
  })
}

/**
 * Next stage is the registry, not enrichment.
 *
 * Phase 3 inserts two naming stages between the crawl and the mailbox work:
 * `crawl:site → registry:match → [serp:owner] → enrich:lead`. registry:match
 * decides for itself whether SERP is worth buying, so this is the only hop
 * crawl needs to know about.
 *
 * A lead whose crawl found nothing still goes here — a business with an
 * unreachable website can still be named by its state filing.
 */
async function queueRegistry(ctx: JobContext, campaignId: string, leadId: string) {
  await ctx.helpers.addJob('registry:match', { campaignId, leadId },
    { jobKey: jobKey('registry:match', campaignId, leadId), maxAttempts: 3 })
}

export async function recordSourceCost(
  db: TaskDeps['db'], campaignId: string, source: string, stage: string,
  units: number, bytesByPool: Record<string, number>,
  llmIn: number, llmOut: number, cents: number,
) {
  const proxyBytes = bytesByPool['decodo_residential'] ?? 0
  const dcBytes = bytesByPool['datacenter'] ?? 0
  await db.query(
    `select add_source_cost($1,$2,$3,$4,$5,$6,$7,$8)`,
    [campaignId, source, stage, units, proxyBytes, llmIn, llmOut, cents])
  if (dcBytes) {
    await db.query(
      `select add_source_cost($1,$2,$3,0,$4,0,0,0)`,
      [campaignId, `${source}:datacenter`, stage, dcBytes])
  }
}
