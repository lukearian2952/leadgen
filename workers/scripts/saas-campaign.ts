// Create a SaaS/online-niche campaign and start discovery.
//
// The counterpart to `niche-campaign.ts`, which starts a `maps:discover`. An
// online niche has no storefront, so discovery is `saas:discover` instead —
// see `sources/saas.ts`.
//
// Usage:
//   npx tsx scripts/saas-campaign.ts start "<niche>" "<location>" [target]
//   npx tsx scripts/saas-campaign.ts status <campaignId>

import pg from 'pg'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const command = process.argv[2] ?? 'status'

if (command === 'start') {
  const niche = process.argv[3]
  const location = process.argv[4] ?? 'United States'
  const target = Number(process.argv[5] ?? 100)
  if (!niche) throw new Error('usage: saas-campaign.ts start "<niche>" "<location>" [target]')

  // `campaigns.user_id` is NOT NULL and carries the RLS owner. Scripts inherit
  // it from the most recent campaign rather than inventing one, the same way
  // niche-campaign.ts does — a campaign owned by nobody is invisible in the UI.
  const { rows: [owner] } = await db.query<{ user_id: string }>(
    `select user_id from campaigns order by created_at desc limit 1`)
  if (!owner) throw new Error('no existing campaign to inherit user_id from')

  const { rows } = await db.query<{ id: string }>(
    `insert into campaigns
       (user_id, niche, location, target_count, status, current_step, spend_detail)
     values ($1, $2, $3, $4, 'running', 1, $5::jsonb)
     returning id`,
    [owner.user_id, niche, location, target,
     JSON.stringify({ run_label: `saas-${slug(niche)}-${slug(location)}` })])

  const campaignId = rows[0].id

  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, null, $3, $4)`,
    ['saas:discover',
     JSON.stringify({ campaignId, niche, location, targetCount: target }),
     2, `${campaignId}:all:saas:discover`])

  console.log(`campaign ${campaignId}`)
  console.log(`  niche    ${niche}`)
  console.log(`  location ${location}`)
  console.log(`  target   ${target}`)
  console.log('\nenqueued saas:discover')
} else {
  const campaignId = process.argv[3]
  if (!campaignId) throw new Error('usage: saas-campaign.ts status <campaignId>')

  const { rows: [c] } = await db.query(
    `select niche, location, status, current_step, step1_done, target_count
       from campaigns where id = $1`, [campaignId])
  console.log(JSON.stringify(c, null, 1))

  const { rows: funnel } = await db.query(
    `select count(*) discovered,
            count(*) filter (where crawl_done) crawled,
            count(*) filter (where coalesce(owner_first_name,'') <> '') named,
            count(*) filter (where tier = 'A') tier_a,
            count(*) filter (where tier = 'B') tier_b,
            count(*) filter (where tier = 'C') tier_c,
            count(*) filter (where tier = 'rejected') rejected
       from leads where campaign_id = $1`, [campaignId])
  console.log(JSON.stringify(funnel[0], null, 1))

  const { rows: queue } = await db.query(
    `select t.identifier, count(*) n
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where j.payload->>'campaignId' = $1
      group by 1 order by 2 desc`, [campaignId])
  console.log('queue:', queue.length ? JSON.stringify(queue) : 'empty')
}

await db.end()

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
