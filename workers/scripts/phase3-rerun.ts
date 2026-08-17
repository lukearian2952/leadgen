// Seed and start the Phase 3 re-run.
//
// ── Why the same 75 rather than a fresh scrape ───────────────────────────────
//
// The number this phase is judged on is named-rate, measured against Phase 2's
// 18/75. Re-scraping would change the denominator: gosom's 30 city queries at
// depth 10 collapse to ~100 unique places, and which 100 varies run to run. A
// different 75 businesses would move the named-rate for reasons that have
// nothing to do with registry or SERP, and the per-source breakdown would be
// uninterpretable.
//
// So discovery is replayed from campaign fd23a9e1's own rows — same place_ids,
// same businesses, same websites — and everything downstream runs live:
// crawl:site → registry:match → [serp:owner] → enrich:lead → verify.
//
// Usage:
//   npx tsx scripts/phase3-rerun.ts seed     # create the campaign + leads
//   npx tsx scripts/phase3-rerun.ts ingest   # registry:ingest for the scope
//   npx tsx scripts/phase3-rerun.ts start    # enqueue crawl:site per lead
//   npx tsx scripts/phase3-rerun.ts status

import pg from 'pg'

const SOURCE = 'fd23a9e1-a5d9-4dd7-91a1-babcc0179e96'
const MARKER = 'phase3-rerun'

// Transaction pooler (6543), not the session pooler. Seven workers hold 14 of
// the ~15 session-mode slots project-wide, so a session-mode client here is the
// one that gets EMAXCONNSESSION. Jobs are enqueued through
// `graphile_worker.add_job` in SQL rather than through makeWorkerUtils for the
// same reason — it is the same insert, without a second session connection.
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 4,
})

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
  // `campaigns` has no free-text column, so the marker lives in `spend_detail`,
  // which is jsonb and already campaign-scoped bookkeeping.
  const { rows } = await db.query<{ id: string }>(
    `select id from campaigns where spend_detail->>'run_label' = $1
      order by created_at desc limit 1`, [MARKER])
  return rows[0]?.id ?? null
}

async function seed(): Promise<string> {
  const existing = await findCampaign()
  if (existing) { console.log('campaign already seeded:', existing); return existing }

  const { rows: [src] } = await db.query(
    `select user_id, niche, location, target_count from campaigns where id = $1`, [SOURCE])

  const { rows: [c] } = await db.query<{ id: string }>(
    `insert into campaigns (user_id, niche, location, target_count, status, current_step, spend_detail)
     values ($1,$2,$3,$4,'running',2, jsonb_build_object('run_label',$5::text)) returning id`,
    [src.user_id, src.niche, src.location, src.target_count, MARKER])

  // Copy the discovery output verbatim: same businesses, same place_ids, same
  // websites. Nothing downstream of discovery is carried over — no names, no
  // emails, no tiers — so every naming and verification result is earned again.
  const { rowCount } = await db.query(
    `insert into leads
       (campaign_id, business_id, business_name, phone, website, place_id, city, state,
        country, formatted_address, category, county, sources, evidence)
     select $1, business_id, business_name, phone, website, place_id, city, state,
            country, formatted_address, category, county,
            array['google_maps'],
            jsonb_build_object(
              'maps_link',   evidence->'maps_link',
              'maps_emails', coalesce(evidence->'maps_emails','[]'::jsonb),
              'maps_owner',  evidence->'maps_owner',
              'category',    evidence->'category',
              'review_count',evidence->'review_count',
              -- Same value passed twice on purpose: reusing $2 below makes
              -- Postgres infer it as text here, then fail on uuid = text.
              'replayed_from', $2::text)
       from leads where campaign_id = $3::uuid`,
    [c.id, SOURCE, SOURCE])

  await db.query(
    `update campaigns set step1_done = $2, stat_dropped_step1 =
       (select stat_dropped_step1 from campaigns where id = $3) where id = $1`,
    [c.id, rowCount, SOURCE])

  console.log(`seeded campaign ${c.id} with ${rowCount} leads replayed from ${SOURCE}`)
  return c.id
}

async function ingest(): Promise<void> {
  {
    await addJob('registry:ingest', {
      state: 'NY',
      counties: ['Nassau', 'Suffolk'],
      nameContains: ['SPA', 'AESTHETIC', 'ESTHETIC', 'SKIN', 'LASER', 'DERM', 'BEAUTY',
                     'COSMETIC', 'REJUV', 'GLOW', 'WELLNESS', 'MEDI', 'BOTOX', 'INJECT'],
      limit: 60000,
    }, { jobKey: jobKey('registry:ingest', 'global'), maxAttempts: 3 })
    console.log('registry:ingest enqueued for NY Nassau+Suffolk')
  }
}

async function start(): Promise<void> {
  const campaignId = await findCampaign()
  if (!campaignId) throw new Error('no seeded campaign — run `seed` first')

  const { rows } = await db.query<{ id: string; website: string; business_name: string }>(
    `select id, website, business_name from leads where campaign_id = $1`, [campaignId])

  {
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
        // No website: the gate needs a domain, so registry cannot rescue it.
        // Finalised here exactly as maps:discover would have.
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
}

async function status(): Promise<void> {
  const campaignId = await findCampaign()
  if (!campaignId) { console.log('not seeded'); return }

  const { rows: [c] } = await db.query(
    `select status, current_step from campaigns where id = $1`, [campaignId])
  const { rows: [s] } = await db.query(
    `select count(*)::int total,
            count(*) filter (where crawl_done)::int crawled,
            count(*) filter (where name_done)::int named_stage,
            count(*) filter (where enrich_done)::int enriched,
            count(*) filter (where owner_first_name <> '')::int named,
            count(*) filter (where tier='A')::int a,
            count(*) filter (where tier='B')::int b,
            count(*) filter (where tier='C')::int c,
            count(*) filter (where tier='rejected')::int rejected
       from leads where campaign_id = $1`, [campaignId])
  const { rows: q } = await db.query(
    `select task_identifier, count(*)::int n from graphile_worker.jobs
      group by 1 order by 2 desc`)

  console.log(`campaign ${campaignId} — ${c.status} (step ${c.current_step})`)
  console.log(s)
  console.log('queue:', q.length ? q : '(empty)')
}

const cmd = process.argv[2] ?? 'status'
try {
  if (cmd === 'seed') await seed()
  else if (cmd === 'ingest') await ingest()
  else if (cmd === 'start') await start()
  else await status()
} finally { await db.end() }
