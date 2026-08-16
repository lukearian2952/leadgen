// campaign:reconcile — the watchdog, rebuilt as a job.
//
// graphile-worker retries a job that *fails*. It cannot see a campaign whose
// jobs all succeeded but which never got enqueued for its next stage — which is
// exactly how v1 stranded campaigns in `running` for 43 days. So this
// re-derives, from the rows themselves, what each campaign still owes, and
// closes it out when nothing is left.
//
// Idempotent and safe to run repeatedly: it only enqueues work that is
// provably missing, and job_key dedupe stops a double-enqueue turning into
// double spend.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey } from './wrap.js'
import type { TaskDeps } from './index.js'

interface Payload { campaignId?: string; [key: string]: unknown }

/** Below this share of discovered businesses reaching Tier A/B, warn loudly. */
const LOW_YIELD_THRESHOLD = 0.25

export function makeReconcileTask(deps: TaskDeps): Task {
  const { db } = deps

  return wrapTask<Payload>({ stage: 'campaign:reconcile', db }, async (payload, ctx) => {
    const ids = payload.campaignId
      ? [payload.campaignId]
      : (await db.query<{ id: string }>(
          `select id from campaigns where status = 'running'`)).rows.map(r => r.id)

    for (const campaignId of ids) {
      const { rows: [counts] } = await db.query<{
        total: string; crawled: string; enriched: string
        tier_a: string; tier_b: string; tier_c: string; rejected: string
      }>(
        `select count(*)::text total,
                count(*) filter (where crawl_done)::text crawled,
                count(*) filter (where enrich_done)::text enriched,
                count(*) filter (where tier = 'A')::text tier_a,
                count(*) filter (where tier = 'B')::text tier_b,
                count(*) filter (where tier = 'C')::text tier_c,
                count(*) filter (where tier = 'rejected')::text rejected
           from leads where campaign_id = $1`, [campaignId])

      const total = Number(counts?.total ?? 0)
      const enriched = Number(counts?.enriched ?? 0)
      if (!total) { ctx.logger.info('campaign has no leads yet', { campaignId }); continue }

      // Re-enqueue anything provably stalled. `job_key` makes this a no-op when
      // the job is already queued.
      const { rows: stalledCrawl } = await db.query<{ id: string; website: string; business_name: string }>(
        `select id, website, business_name from leads
          where campaign_id = $1 and not crawl_done and website <> '' limit 200`, [campaignId])
      for (const lead of stalledCrawl) {
        await ctx.helpers.addJob('crawl:site',
          { campaignId, leadId: lead.id, website: lead.website,
            domain: '', businessName: lead.business_name },
          { jobKey: jobKey('crawl:site', campaignId, lead.id), maxAttempts: 3 })
      }

      const { rows: stalledEnrich } = await db.query<{ id: string }>(
        `select id from leads
          where campaign_id = $1 and crawl_done and not enrich_done limit 200`, [campaignId])
      for (const lead of stalledEnrich) {
        await ctx.helpers.addJob('enrich:lead', { campaignId, leadId: lead.id },
          { jobKey: jobKey('enrich:lead', campaignId, lead.id), maxAttempts: 3 })
      }

      const outstanding = stalledCrawl.length + stalledEnrich.length
      if (outstanding > 0) {
        ctx.logger.info('campaign still working', {
          campaignId, total, enriched, requeued: outstanding })
        // Check again shortly; this is the loop that replaces pg_cron.
        await ctx.helpers.addJob('campaign:reconcile', { campaignId },
          { jobKey: jobKey('campaign:reconcile', campaignId),
            runAt: new Date(Date.now() + 60_000) })
        continue
      }

      // ── finished ──────────────────────────────────────────────────────────
      const tierA = Number(counts.tier_a)
      const tierB = Number(counts.tier_b)
      const mailable = tierA + tierB
      const lowYield = total > 0 && mailable / total < LOW_YIELD_THRESHOLD

      await db.query(
        `update campaigns
            set status = $2, current_step = 6, completed_at = now(),
                step1_done = $3, stat_owner_ready = $4, stat_rejected = $5,
                stat_owners = (select count(*) from leads
                                where campaign_id = $1 and owner_first_name <> ''),
                stat_emails = (select count(*) from leads
                                where campaign_id = $1 and (owner_email <> '' or email <> ''))
          where id = $1`,
        [campaignId, lowYield ? 'completed_low_yield' : 'completed',
         total, mailable, total - mailable])

      ctx.cost.detail = {
        total, tier_a: tierA, tier_b: tierB,
        tier_c: Number(counts.tier_c), rejected: Number(counts.rejected),
        low_yield: lowYield,
      }
      ctx.logger.info('campaign finalized', { campaignId, ...ctx.cost.detail })
    }
  })
}
