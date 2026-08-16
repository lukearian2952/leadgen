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
  parseName, isOwnerTitle, isGenericLocalPart, isJunkDomain,
  emailDomain, isValidEmail,
} from '../lib/identity.js'

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
      await queueEnrich(ctx, campaignId, leadId)
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

    // ── owner name ────────────────────────────────────────────────────────────
    let first = '', last = '', title = '', isDoctor = false, ownerSource = ''

    if (config.anthropicApiKey && result.text.length > 200) {
      const llm = await askJson<{ people?: Array<{ full_name?: string; title?: string; confidence?: string }> }>(
        config.anthropicApiKey,
        peoplePrompt(businessName, result.text),
        PEOPLE_SCHEMA, 1500,
      )
      usage = addUsage(usage, llm.usage)
      if (llm.error) ctx.logger.warn('haiku extraction failed', { err: llm.error })

      const people = llm.data?.people ?? []
      evidence.people_found = people.slice(0, 5)

      for (const person of people) {
        if (!isOwnerTitle(person.title ?? '')) continue
        const parsed = parseName(person.full_name ?? '')
        if (parsed.reject) continue
        // Corroboration: the page must actually contain the name.
        if (!nameAppearsInText(parsed.first, parsed.last, result.text)) {
          evidence.rejected_uncorroborated = person.full_name
          continue
        }
        first = parsed.first; last = parsed.last
        title = (person.title ?? '').trim()
        isDoctor = parsed.isDoctor
        ownerSource = 'site_crawl'
        break
      }
    }

    evidence.owner_source = ownerSource || 'none'
    if (title) evidence.owner_title = title

    await db.query(
      `update leads
          set crawl_done = true,
              owner_first_name = coalesce(nullif($2,''), owner_first_name),
              owner_last_name  = coalesce(nullif($3,''), owner_last_name),
              owner_name       = coalesce(nullif($4,''), owner_name),
              title            = coalesce(nullif($5,''), title),
              is_doctor        = $6 or is_doctor,
              owner_source     = coalesce(nullif($7,''), owner_source),
              email            = coalesce(nullif($8,''), email),
              sources          = array(select distinct unnest(sources || array['site_crawl'])),
              evidence         = evidence || $9::jsonb
        where id = $1`,
      [leadId, first, last, [first, last].filter(Boolean).join(' '), title, isDoctor,
       ownerSource, generalEmail || personalEmail, JSON.stringify(evidence)])

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
      named: Boolean(first),
      emails_found: onDomain.length,
      haiku_calls: usage.calls,
      haiku_input_tokens: usage.inputTokens,
      haiku_output_tokens: usage.outputTokens,
    }

    await recordSourceCost(db, campaignId, 'site_crawl', 'crawl',
      1, result.bytesByPool, usage.inputTokens, usage.outputTokens, ctx.cost.cents)

    await queueEnrich(ctx, campaignId, leadId)
  })
}

async function queueEnrich(ctx: JobContext, campaignId: string, leadId: string) {
  await ctx.helpers.addJob('enrich:lead', { campaignId, leadId },
    { jobKey: jobKey('enrich:lead', campaignId, leadId), maxAttempts: 3 })
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
