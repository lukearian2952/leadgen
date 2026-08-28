// The SERP phrasing experiment (HANDOFF §9).
//
// ── The cohort, and why a fresh campaign ─────────────────────────────────────
//
// The 93 leads of campaign 0880d44f that finished unnamed. They are replayed
// into a *new* campaign rather than re-run in place, for two reasons:
//
//   1. The baseline has to survive. Re-running in place overwrites the very
//      rows the experiment is measured against, and there is no way back —
//      `putCandidates` replaces per source and `applyNameDecision` rewrites the
//      lead. A before/after where the "before" has been destroyed is not a
//      measurement.
//   2. The Verifalia cap is per campaign. `PgBudgetLedger` reads cumulative
//      spend for the campaign id, so a 300¢ cap on 0880d44f — which has already
//      spent — would be exhausted before the first check. A new campaign gets a
//      clean ledger, and 300¢ means 300¢.
//
// ── The baseline, corrected ──────────────────────────────────────────────────
//
// HANDOFF §9 quotes "6 per 100". That is right for the stage and wrong for this
// cohort: serp:owner ran on 100 leads, which were exactly these 93 plus 7 that
// other sources had already named, and **all 6 candidates came from those 7**.
// Over the 93 the old phrasing scored 0. That is the number to beat.
//
// Usage:
//   npx tsx scripts/serp-founder-exp.ts seed
//   npx tsx scripts/serp-founder-exp.ts start
//   npx tsx scripts/serp-founder-exp.ts status
//   npx tsx scripts/serp-founder-exp.ts report

import { appPool } from './_db.js'

const SOURCE = '0880d44f-400c-4132-91ac-9c142a448390'
const MARKER = process.env.RUN_LABEL ?? 'serp-founder-exp'

const db = appPool(4)

async function addJob(
  identifier: string, payload: Record<string, unknown>,
  opts: { jobKey?: string; maxAttempts?: number; runAt?: Date } = {},
): Promise<void> {
  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, $3, $4, $5)`,
    [identifier, JSON.stringify(payload), opts.runAt ?? null,
     opts.maxAttempts ?? null, opts.jobKey ?? null])
}

const jobKey = (stage: string, c: string, l?: string) =>
  [c, l ?? 'all', stage].join(':')

async function findCampaign(): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaigns where spend_detail->>'run_label' = $1
      order by created_at desc limit 1`, [MARKER])
  return rows[0]?.id ?? null
}

async function seed(): Promise<string> {
  const existing = await findCampaign()
  if (existing) { console.log('already seeded:', existing); return existing }

  const { rows: [src] } = await db.query(
    `select user_id, niche, location, target_count from campaigns where id = $1`, [SOURCE])

  const { rows: [c] } = await db.query<{ id: string }>(
    `insert into campaigns (user_id, niche, location, target_count, status, current_step, spend_detail)
     values ($1,$2,$3,$4,'running',2, jsonb_build_object('run_label',$5::text)) returning id`,
    [src.user_id, src.niche, src.location, src.target_count, MARKER])

  // Discovery output only. No names, no candidates, no emails, no tiers — every
  // naming result in this campaign is earned by the new queries and the new
  // crawl paths, not inherited.
  const { rowCount } = await db.query(
    `insert into leads
       (campaign_id, business_id, business_name, phone, website, place_id, city, state,
        country, formatted_address, category, county, sources, evidence)
     select $1, business_id, business_name, phone, website, place_id, city, state,
            country, formatted_address, category, county, sources,
            jsonb_build_object('replayed_from', $2::text, 'cohort', 'saas_unnamed_93')
       from leads
      where campaign_id = $3::uuid and owner_first_name = ''`,
    [c.id, SOURCE, SOURCE])

  await db.query(`update campaigns set step1_done = $2 where id = $1`, [c.id, rowCount])
  console.log(`seeded ${c.id} with ${rowCount} leads replayed from ${SOURCE}`)
  return c.id
}

async function start(): Promise<void> {
  const campaignId = await findCampaign()
  if (!campaignId) throw new Error('no seeded campaign — run `seed` first')

  const { rows } = await db.query<{ id: string; website: string; business_name: string }>(
    `select id, website, business_name from leads where campaign_id = $1`, [campaignId])

  let crawled = 0, direct = 0
  for (const lead of rows) {
    const domain = lead.website
      ? lead.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()
      : ''
    if (domain) {
      await addJob('crawl:site',
        { campaignId, leadId: lead.id, website: lead.website, domain,
          businessName: lead.business_name },
        { jobKey: jobKey('crawl:site', campaignId, lead.id), maxAttempts: 3 })
      crawled++
    } else {
      await db.query(
        `update leads set crawl_done = true, name_done = true, enrich_done = true,
                          tier = 'rejected', reject_reason = 'no_website' where id = $1`,
        [lead.id])
      direct++
    }
  }
  await addJob('campaign:reconcile', { campaignId },
    { jobKey: jobKey('campaign:reconcile', campaignId),
      runAt: new Date(Date.now() + 120_000) })
  console.log(`started ${campaignId}: ${crawled} crawl jobs, ${direct} rejected (no website)`)
}

async function status(): Promise<void> {
  const campaignId = await findCampaign()
  if (!campaignId) { console.log('not seeded'); return }

  const { rows: [c] } = await db.query(
    `select status, current_step from campaigns where id = $1`, [campaignId])
  const { rows: [s] } = await db.query(
    `select count(*)::int total,
            count(*) filter (where crawl_done)::int crawled,
            count(*) filter (where name_done)::int name_stage,
            count(*) filter (where enrich_done)::int enriched,
            count(*) filter (where owner_first_name <> '')::int named,
            count(*) filter (where tier='A')::int a,
            count(*) filter (where tier='B')::int b,
            count(*) filter (where tier='C')::int c,
            count(*) filter (where tier='rejected')::int rejected
       from leads where campaign_id = $1`, [campaignId])
  const { rows: j } = await db.query(
    `select stage, status, count(*)::int n, round(sum(cost_cents)::numeric,2) cents
       from job_runs where campaign_id = $1 group by 1,2 order by 1,2`, [campaignId])
  const { rows: q } = await db.query(
    `select t.identifier, count(*)::int n
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      group by 1 order by 2 desc`)

  console.log(`campaign ${campaignId} — ${c.status} (step ${c.current_step})`)
  console.log(s)
  console.log('stages:', j)
  console.log('queue:', q.length ? q : '(empty)')
}

/** The experiment's answer, next to the baseline it has to beat. */
async function report(): Promise<void> {
  const campaignId = await findCampaign()
  if (!campaignId) { console.log('not seeded'); return }

  const { rows: [serp] } = await db.query(
    `select count(*)::int runs,
            count(*) filter (where (detail->>'candidates')::int > 0)::int with_candidate,
            count(*) filter (where (detail->>'owner_grade')::int > 0)::int owner_grade,
            sum((detail->>'cached_queries')::int)::int cached_queries,
            round(sum(cost_cents)::numeric,2) cents
       from job_runs where campaign_id = $1 and stage = 'serp:owner'`, [campaignId])

  const { rows: [crawl] } = await db.query(
    `select count(*)::int runs,
            round(avg((detail->>'pages')::int),2) avg_pages,
            count(*) filter (where (detail->>'people_on_site')::int > 0)::int with_people,
            count(*) filter (where (detail->>'candidates')::int > 0)::int with_candidate
       from job_runs where campaign_id = $1 and stage = 'crawl:site'`, [campaignId])

  const { rows: [out] } = await db.query(
    `select count(*)::int total,
            count(*) filter (where owner_first_name <> '')::int named,
            count(*) filter (where owner_source = 'serp')::int named_by_serp,
            count(*) filter (where owner_source = 'site_crawl')::int named_by_crawl,
            count(*) filter (where tier='A')::int tier_a,
            count(*) filter (where tier='B')::int tier_b,
            count(*) filter (where tier='C')::int tier_c
       from leads where campaign_id = $1`, [campaignId])

  const { rows: [spend] } = await db.query(
    `select round(sum(cost_cents)::numeric,2) cents from job_runs where campaign_id = $1`,
    [campaignId])

  const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : '—'

  console.log(`\n── SERP phrasing experiment — campaign ${campaignId} ──`)
  console.log(`cohort            ${out.total} leads (the unnamed 93 of ${SOURCE.slice(0, 8)})`)
  console.log(`\nserp:owner        ${serp.runs} runs, ${serp.with_candidate} with a candidate  ` +
              `(${pct(serp.with_candidate, serp.runs)})   baseline on this cohort: 0`)
  console.log(`                  ${serp.owner_grade} owner-grade · ${serp.cached_queries ?? 0} cached queries · ${serp.cents}¢`)
  console.log(`crawl:site        ${crawl.runs} runs, avg ${crawl.avg_pages} pages, ` +
              `${crawl.with_people} with people, ${crawl.with_candidate} with a candidate`)
  console.log(`\nnamed             ${out.named} / ${out.total}  (${pct(out.named, out.total)})   baseline: 0`)
  console.log(`  by serp         ${out.named_by_serp}`)
  console.log(`  by site_crawl   ${out.named_by_crawl}`)
  console.log(`\ntier A            ${out.tier_a}`)
  console.log(`tier B            ${out.tier_b}`)
  console.log(`tier C            ${out.tier_c}`)
  console.log(`new sendable      ${out.tier_a + out.tier_b}  (A+B, all of it net new)`)
  console.log(`\ntotal spend       ${spend.cents}¢`)
}

const cmd = process.argv[2]
const run =
  cmd === 'seed' ? seed :
  cmd === 'start' ? start :
  cmd === 'status' ? status :
  cmd === 'report' ? report :
  null

if (!run) { console.error('usage: serp-founder-exp.ts seed|start|status|report'); process.exit(1) }
run().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
