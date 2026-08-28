// Re-run serp:owner over the experiment cohort at a pace Google CSE survives.
//
// ── Why the first run's SERP number is not usable ────────────────────────────
//
// The founder phrasing scored 1/89. That is not a measurement of the phrasing.
// `site:linkedin.com/in` is only honoured by the `google cse` upstream; Bing
// silently discards the operator and answers with the company's own domain.
// Across the first run the engine split was:
//
//     bing         2040 results,  3 with a linkedin.com/in URL   (0.15%)
//     google cse     89 results, 17 with a linkedin.com/in URL   (19%)
//
// A controlled probe then found why: CSE answers about **nine** queries and is
// then suspended for ~2 minutes ("too many requests"). serp:owner fired 267
// queries in four minutes, so CSE was suspended for essentially all of it and
// Bing answered 96% of the run. The same query issued by hand, on the same
// instance, returns 20 LinkedIn profiles.
//
// This is the failure mode `searxng/settings.yml` already documents and
// HANDOFF §11 lists as having caused a retraction before: the instance still
// answers 200 with a `results` array, just a much worse one.
//
// So: clear the cached bad answers, re-enqueue one lead at a time with enough
// spacing that CSE is awake, and measure again. The crawl output is left alone
// — same crawl, different SERP, which isolates the variable properly.
//
// Usage:
//   npx tsx scripts/serp-reserp.ts arm      # clear cache, enqueue staggered
//   npx tsx scripts/serp-reserp.ts progress

import { appPool } from './_db.js'

const MARKER = process.env.RUN_LABEL ?? 'serp-founder-exp'
/** Seconds between leads. Three queries per lead against ~3.6 CSE queries/min. */
const STAGGER = Number(process.env.STAGGER_SECONDS ?? 50)

const db = appPool(4)

async function findCampaign(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaigns where spend_detail->>'run_label' = $1
      order by created_at desc limit 1`, [MARKER])
  if (!rows[0]) throw new Error('no seeded campaign')
  return rows[0].id
}

async function arm(): Promise<void> {
  const campaignId = await findCampaign()

  // 1. Drop the cached answers for the founder query shapes. Without this the
  //    30-day cache replays the Bing-only results and the re-run measures
  //    nothing at all.
  const { rowCount: cleared } = await db.query(
    `delete from serp_cache
      where query like '%founder OR CEO OR "co-founder" site:linkedin.com/in'
         or query like '%"founded by" OR "our story"'
         or query like 'site:% about OR team OR leadership'`)

  // 2. Reopen the campaign so campaign:reconcile does not finalise it early.
  await db.query(
    `update campaigns set status = 'running', current_step = 2 where id = $1`, [campaignId])

  // 3. Re-enqueue serp:owner one lead at a time. The stagger is the whole
  //    point: graphile only makes a job runnable at its run_at, so spacing
  //    them throttles the stage regardless of worker concurrency.
  const { rows } = await db.query<{ id: string }>(
    `select id from leads where campaign_id = $1 order by business_name`, [campaignId])

  const t0 = Date.now()
  for (const [i, lead] of rows.entries()) {
    const runAt = new Date(t0 + i * STAGGER * 1000)
    await db.query(
      `select graphile_worker.add_job($1, $2::json, null, $3, $4, $5)`,
      ['serp:owner', JSON.stringify({ campaignId, leadId: lead.id }),
       runAt, 2, `${campaignId}:${lead.id}:serp:owner:reserp`])
  }

  // Reconcile after the last lead, plus a margin for enrich and verify.
  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, $3, $4, $5)`,
    ['campaign:reconcile', JSON.stringify({ campaignId }),
     new Date(t0 + (rows.length * STAGGER + 900) * 1000), 3,
     `${campaignId}:all:campaign:reconcile:reserp`])

  const minutes = Math.round(rows.length * STAGGER / 60)
  console.log(`cleared ${cleared} cached queries`)
  console.log(`enqueued ${rows.length} serp:owner jobs, ${STAGGER}s apart — ~${minutes} min`)
}

async function progress(): Promise<void> {
  const campaignId = await findCampaign()
  const { rows: [j] } = await db.query(
    `select count(*)::int done,
            count(*) filter (where (detail->>'candidates')::int > 0)::int with_candidate
       from job_runs
      where campaign_id = $1 and stage = 'serp:owner'
        and started_at > now() - interval '4 hours'`, [campaignId])
  const { rows: [q] } = await db.query(
    `select count(*)::int pending from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'serp:owner'`)
  // Did CSE actually answer? The engine mix is the health signal for this run.
  const { rows: [e] } = await db.query(
    `select count(*) filter (where r->>'engine' = 'google cse')::int cse,
            count(*) filter (where r->>'engine' = 'bing')::int bing,
            count(*) filter (where r->>'url' like '%linkedin.com/in%')::int linkedin
       from serp_cache c, jsonb_array_elements(c.results) r
      where c.fetched_at > now() - interval '4 hours'`)

  console.log({ serp_runs_last_4h: j.done, with_candidate: j.with_candidate,
                pending: q.pending, engine_mix: e })
}

const cmd = process.argv[2]
const run = cmd === 'arm' ? arm : cmd === 'progress' ? progress : null
if (!run) { console.error('usage: serp-reserp.ts arm|progress'); process.exit(1) }
run().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
