// Re-run `enrich:lead` for leads that were named but never got a verdict.
//
// ── Why this is not the same as re-running the stage for everything ──────────
//
// A Verifalia outage produces `email_status = 'unknown'`, which is the *absence
// of a verdict*, not a statement about the mailbox. Those rows land at Tier C
// —"named, not reachable"— indistinguishably from a row we genuinely could not
// reach. Once credits exist, only those rows can change: a lead whose address
// came back `Deliverable` or `Undeliverable` has an answer already, and paying
// to re-ask costs money to learn nothing.
//
// `enrich:lead` and not `registry:match`, because the name is already stored
// and re-deciding it would re-run the whole naming chain for a question about
// deliverability. Nothing here crawls.
//
// Usage:
//   npx tsx scripts/reverify.ts <campaignId> [--apply]

import pg from 'pg'

const campaignId = process.argv[2]
const apply = process.argv.includes('--apply')
if (!campaignId) throw new Error('usage: reverify.ts <campaignId> [--apply]')

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
  connectionTimeoutMillis: 10_000, query_timeout: 60_000,
})

// Named, and holding no verdict. `email_status` is the classification of
// `owner_email`; 'unknown' or empty means nothing ever answered.
const { rows: targets } = await db.query<{ id: string; business_name: string }>(
  `select id, business_name
     from leads
    where campaign_id = $1
      and coalesce(owner_first_name,'') <> ''
      and coalesce(email_status,'') in ('', 'unknown')
    order by business_name`, [campaignId])

const { rows: [spent] } = await db.query<{ cents: string }>(
  `select coalesce(round(sum(cost_cents)), 0) cents from source_costs
    where campaign_id = $1 and source = 'verifalia'`, [campaignId])

// Measured on the run that exhausted the account: 224 candidate checks across
// 51 leads, so ~4.4 checks each at 0.3¢.
const CENTS_PER_LEAD = 1.4
const estimate = Math.ceil(targets.length * CENTS_PER_LEAD)
const already = Number(spent.cents)

console.log(`campaign ${campaignId}`)
console.log(`  named but unverified: ${targets.length}`)
console.log(`  verifalia spent:      ${already}¢`)
console.log(`  rough estimate:       +${estimate}¢  →  ${already + estimate}¢ of 3000¢`)

if (!targets.length) {
  console.log('\nnothing to re-verify')
  await db.end()
  process.exit(0)
}

if (already + estimate > 3000) {
  throw new Error(`estimated ${already + estimate}¢ exceeds the 3000¢ per-campaign cap`)
}

if (!apply) {
  console.log('\ndry run — pass --apply to enqueue')
  console.log(targets.slice(0, 10).map(t => `  ${t.business_name}`).join('\n'))
  await db.end()
  process.exit(0)
}

for (const t of targets) {
  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, null, $3, $4)`,
    ['enrich:lead', JSON.stringify({ campaignId, leadId: t.id }), 3,
     `${campaignId}:${t.id}:enrich:lead`])
}

console.log(`\nenqueued ${targets.length} enrich:lead jobs`)
await db.end()
