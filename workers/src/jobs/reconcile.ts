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
import { PgAlertSink, ALERT_UNVERIFIED_TIERED } from '../verify/alerts.js'

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

      // Phase 3 put two naming stages between the crawl and enrichment, so
      // "crawled but not enriched" is no longer one gap but two. Re-enqueueing
      // enrich:lead for a lead that has not been through registry:match would
      // silently skip naming altogether and reproduce the Phase 2 result.
      //
      // `not enrich_done` is on both queries because maps:discover finalises
      // website-less leads outright (crawl_done and enrich_done, never named);
      // without it those would be re-enqueued for naming forever.
      const { rows: stalledName } = await db.query<{ id: string }>(
        `select id from leads
          where campaign_id = $1 and crawl_done and not name_done and not enrich_done
          limit 200`, [campaignId])
      for (const lead of stalledName) {
        await ctx.helpers.addJob('registry:match', { campaignId, leadId: lead.id },
          { jobKey: jobKey('registry:match', campaignId, lead.id), maxAttempts: 3 })
      }

      const { rows: stalledEnrich } = await db.query<{ id: string }>(
        `select id from leads
          where campaign_id = $1 and name_done and not enrich_done limit 200`, [campaignId])
      for (const lead of stalledEnrich) {
        await ctx.helpers.addJob('enrich:lead', { campaignId, leadId: lead.id },
          { jobKey: jobKey('enrich:lead', campaignId, lead.id), maxAttempts: 3 })
      }

      const outstanding = stalledCrawl.length + stalledName.length + stalledEnrich.length
      if (outstanding > 0) {
        ctx.logger.info('campaign still working', {
          campaignId, total, enriched, requeued: outstanding })
        // Check again shortly; this is the loop that replaces pg_cron.
        await ctx.helpers.addJob('campaign:reconcile', { campaignId },
          { jobKey: jobKey('campaign:reconcile', campaignId),
            runAt: new Date(Date.now() + 60_000) })
        continue
      }

      // ── is discovery still running? ───────────────────────────────────────
      //
      // Multi-batch discovery broke the old assumption that an empty per-lead
      // queue means the campaign is done. On the 1,000-business national run
      // reconcile fired in the gap between batch 0's leads finishing enrichment
      // and batch 1's leads existing, saw nothing outstanding, and marked a
      // campaign `completed_low_yield` at 115 of 1,000 while discovery carried
      // on behind it.
      //
      // The queue is the authority: maps:discover enqueues its successor before
      // returning, so a queued or locked discovery job for this campaign means
      // more leads are coming. Checked here rather than via a flag on the
      // campaign so no new column has to be kept in sync by two writers.
      //
      // `_private_jobs`, not the public `graphile_worker.jobs` view: the view
      // exposes task_identifier and locks but NOT payload, so filtering by
      // campaign is only possible on the private table.
      const { rows: [discovery] } = await db.query<{ n: string }>(
        `select count(*)::text n
           from graphile_worker._private_jobs j
           join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier = 'maps:discover'
            and j.payload->>'campaignId' = $1`, [campaignId])

      if (Number(discovery?.n ?? 0) > 0) {
        ctx.logger.info('discovery still in flight — not finalising', {
          campaignId, total, discoveryJobs: Number(discovery.n),
        })
        await ctx.helpers.addJob('campaign:reconcile', { campaignId },
          { jobKey: jobKey('campaign:reconcile', campaignId),
            runAt: new Date(Date.now() + 120_000) })
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

      // ── the unverified-tier check ─────────────────────────────────────────
      //
      // A lead that reached A, B or C without any verifier ever running on it
      // was never judged — it was *assumed*. This is checked at finalisation
      // because that is the moment the tier stops being provisional and starts
      // being a number someone quotes.
      //
      // Both counters, because the topology decides which one moves: with
      // VERIFIER=verifalia the paid provider is primary, under `hybrid` it is
      // verify-svc. Zero of both means nothing checked anything.
      //
      // `rejected` is excluded deliberately: a lead with no candidate addresses
      // is rejected before verification by design, and counting it here would
      // make the alert fire on every campaign and therefore mean nothing.
      const { rows: [unverified] } = await db.query<{ n: string }>(
        `select count(*)::text n
           from leads l
          where l.campaign_id = $1
            and l.tier in ('A','B','C')
            and not exists (
              select 1 from job_runs j
               where j.lead_id = l.id
                 and j.stage = 'enrich:lead'
                 and (coalesce((j.detail->>'verifalia_checks')::int, 0)
                    + coalesce((j.detail->>'verify_svc_checks')::int, 0)) > 0)`,
        [campaignId])

      const unverifiedCount = Number(unverified?.n ?? 0)
      if (unverifiedCount > 0) {
        await new PgAlertSink(db, ctx.logger).raise({
          kind: ALERT_UNVERIFIED_TIERED,
          severity: 'warning',
          campaignId,
          message:
            `${unverifiedCount} of ${total} leads were given a tier without any ` +
            `verifier running on them. Their deliverability is unknown in the ` +
            `literal sense — re-run enrich:lead for this campaign before using ` +
            `its yield figures or exporting it.`,
          detail: { unverified: unverifiedCount, total, tier_a: tierA, tier_b: tierB },
        })
      }

      ctx.cost.detail = {
        total, tier_a: tierA, tier_b: tierB,
        tier_c: Number(counts.tier_c), rejected: Number(counts.rejected),
        low_yield: lowYield,
        unverified_tiered: unverifiedCount,
      }
      ctx.logger.info('campaign finalized', { campaignId, ...ctx.cost.detail })
    }
  })
}
