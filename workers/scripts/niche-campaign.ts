// Launch a real end-to-end campaign: discovery included.
//
// Unlike scripts/phase3-rerun.ts, which replays a fixed 75 so the naming delta
// is attributable, this runs the *whole* pipeline from a gosom scrape. That is
// the point of the niche-validation runs — the question is whether the pipeline
// or the niche is the constraint, and answering it needs discovery in the loop.
//
// Usage:
//   npx tsx scripts/niche-campaign.ts create "dental practice" "Long Island, NY" 100
//   npx tsx scripts/niche-campaign.ts ingest <campaignId> NY Nassau,Suffolk
//   npx tsx scripts/niche-campaign.ts status <campaignId>

import pg from 'pg'
import { registryPool } from './_db.js'
import { nicheNameTokens } from '../src/jobs/registry-ingest.js'

// Transaction pooler: seven workers hold 14 of ~15 session slots (HANDOFF §12).
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 3,
})

const jobKey = (stage: string, c: string, l?: string) => [c, l ?? 'all', stage].join(':')

async function addJob(
  identifier: string, payload: Record<string, unknown>,
  opts: { jobKey?: string; maxAttempts?: number; runAt?: Date } = {},
): Promise<void> {
  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, $3, $4, $5)`,
    [identifier, JSON.stringify(payload), opts.runAt ?? null,
     opts.maxAttempts ?? null, opts.jobKey ?? null])
}

async function create(niche: string, location: string, target: number): Promise<void> {
  const { rows: [owner] } = await db.query<{ user_id: string }>(
    `select user_id from campaigns order by created_at desc limit 1`)

  const label = `niche-${niche.replace(/\s+/g, '-')}-${location.replace(/[^a-z]+/gi, '-')}`.toLowerCase()
  const { rows: [existing] } = await db.query<{ id: string }>(
    `select id from campaigns where spend_detail->>'run_label' = $1 limit 1`, [label])
  if (existing) { console.log(`already exists: ${existing.id}`); return }

  const { rows: [c] } = await db.query<{ id: string }>(
    `insert into campaigns (user_id, niche, location, target_count, status, current_step, spend_detail)
     values ($1,$2,$3,$4,'running',1, jsonb_build_object('run_label',$5::text))
     returning id`,
    [owner.user_id, niche, location, target, label])

  // maps:discover chains crawl → registry → [serp] → enrich per lead itself.
  await addJob('maps:discover',
    { campaignId: c.id, niche, location, targetCount: target },
    { jobKey: jobKey('maps:discover', c.id), maxAttempts: 2 })

  console.log(`created ${c.id}  "${niche}" / "${location}" target=${target}  label=${label}`)
}

/**
 * Counties the campaign's own discovered businesses actually landed in.
 *
 * For a statewide campaign ("vehicle wrap shop" / "New York") a blind ingest
 * would pull every matching entity in all 62 NY counties, which is slow and
 * mostly irrelevant — the businesses cluster in a handful. Deriving the scope
 * from discovery output keeps the slice proportional to the campaign.
 *
 * Falls back to whatever the caller passed when discovery has produced no
 * county yet.
 */
async function countiesFromLeads(campaignId: string, state: string): Promise<string[]> {
  // Two statements, not one. `county_for_zip` lives in registry-db now and the
  // leads live in Supabase, so the single-statement form this used to be would
  // not error — it would fail to resolve the function and take the whole query
  // with it. Counties the lead already carries are resolved without asking.
  const { rows } = await db.query<{ county: string; postal_code: string }>(
    `select coalesce(nullif(l.county,''), '') county,
            coalesce(b.postal_code, '') postal_code
       from leads l left join businesses b on b.id = l.business_id
      where l.campaign_id = $1`,
    [campaignId])

  const counties = new Set<string>()
  const zips = new Set<string>()
  for (const r of rows) {
    if (r.county) counties.add(r.county)
    else if (r.postal_code) zips.add(r.postal_code)
  }

  if (zips.size) {
    const registryDb = registryPool(1)
    try {
      const { rows: resolved } = await registryDb.query<{ county: string | null }>(
        `select county_for_zip(z, $2) county from unnest($1::text[]) z`,
        [[...zips], state])
      for (const r of resolved) if (r.county) counties.add(r.county)
    } finally {
      await registryDb.end().catch(() => {})
    }
  }

  return [...counties]
}

async function ingest(campaignId: string, state: string, counties: string): Promise<void> {
  const { rows: [c] } = await db.query<{ niche: string }>(
    `select niche from campaigns where id = $1`, [campaignId])
  const tokens = nicheNameTokens(c.niche)

  if (counties === 'auto') {
    const derived = await countiesFromLeads(campaignId, state)
    counties = derived.join(',')
    console.log(`derived ${derived.length} counties from discovered leads: ${counties || '(none — ingesting statewide)'}`)
  }

  const key = `registry:ingest:${state}:${counties}`

  await db.query(`delete from graphile_worker.jobs where key = $1`, [key]).catch(() => {})
  await addJob('registry:ingest', {
    state,
    counties: counties ? counties.split(',').map(s => s.trim()).filter(Boolean) : [],
    nameContains: tokens,
    limit: 80000,
  }, { jobKey: key, maxAttempts: 3 })

  console.log(`registry:ingest queued — ${state} [${counties || 'all counties'}] tokens=${tokens.join(',')}`)
}

async function status(campaignId: string): Promise<void> {
  const { rows: [c] } = await db.query(
    `select niche, location, status, current_step, step1_done, stat_dropped_step1
       from campaigns where id = $1`, [campaignId])
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
    `select task_identifier, count(*)::int n from graphile_worker.jobs group by 1 order by 2 desc`)
  const { rows: f } = await db.query(
    `select stage, count(*)::int n from job_runs
      where campaign_id = $1 and status = 'failed' group by 1`, [campaignId])

  console.log(`${campaignId}  "${c.niche}" / "${c.location}" — ${c.status} step ${c.current_step}`)
  console.log('  discovery:', { kept: c.step1_done, dropped: c.stat_dropped_step1 })
  console.log('  leads:', s)
  console.log('  queue:', q.length ? q : '(empty)')
  if (f.length) console.log('  FAILED:', f)
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'create') await create(rest[0], rest[1], Number(rest[2] ?? 100))
  else if (cmd === 'ingest') await ingest(rest[0], rest[1] ?? 'NY', rest[2] ?? '')
  else if (cmd === 'status') await status(rest[0])
  else console.log('usage: create <niche> <location> <target> | ingest <id> <state> <counties> | status <id>')
} finally { await db.end() }
