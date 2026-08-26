// Re-run `registry:match` for a named set of leads, and nothing else.
//
// ── Why a subset rather than the campaign ────────────────────────────────────
//
// `registry:match` chains to `enrich:lead`, which constructs candidate
// mailboxes and verifies them through Verifalia at roughly 2.15¢ a check. Over
// 1,042 leads that is the whole remaining budget spent re-deciding rows whose
// inputs did not change. A lead whose name did not change cannot change tier,
// so the only rows worth re-running are the ones `registry-coverage-delta.ts`
// says gain a name.
//
// Nothing here re-crawls: `crawl:site` is not enqueued, and `enrich:lead` reads
// the contacts and domain patterns the original run already stored. The SERP
// call inside address discovery goes to self-hosted SearXNG, which
// `searxng/settings.yml` configures with no outbound proxy — so this costs
// verification credits and no residential bytes.
//
// Usage:
//   npx tsx scripts/rematch-leads.ts <campaignId> <ids.json>   # reads gainedIds
//   npx tsx scripts/rematch-leads.ts <campaignId> --all        # every lead

import pg from 'pg'
import { readFileSync } from 'node:fs'

const campaignId = process.argv[2]
const source = process.argv[3]
if (!campaignId || !source) {
  throw new Error('usage: rematch-leads.ts <campaignId> <ids.json|--all>')
}

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

let ids: string[]
if (source === '--all') {
  const { rows } = await db.query<{ id: string }>(
    'select id from leads where campaign_id = $1', [campaignId])
  ids = rows.map(r => r.id)
} else {
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as { gainedIds?: string[] }
  ids = parsed.gainedIds ?? []
}

if (!ids.length) throw new Error('no lead ids to re-match')

// Guard against the expensive mistake. 51 leads is a bounded experiment; the
// whole campaign is the entire remaining Verifalia budget, and if that is
// genuinely wanted it should be a deliberate `--all`.
const VERIFY_CENTS_PER_LEAD = 12   // ~5.5 candidate checks at 2.15¢, measured
const estimate = ids.length * VERIFY_CENTS_PER_LEAD
const { rows: [spent] } = await db.query<{ cents: string }>(
  `select coalesce(round(sum(cost_cents)), 0) cents from source_costs
    where campaign_id = $1 and source = 'verifalia'`, [campaignId])
const already = Number(spent.cents)

console.log(`leads to re-match:   ${ids.length}`)
console.log(`verifalia spent:     ${already}¢`)
console.log(`rough added estimate: ${estimate}¢  →  ${already + estimate}¢`)
console.log(`campaign cap:        3000¢`)
if (already + estimate > 3000) {
  throw new Error(
    `estimated ${already + estimate}¢ exceeds the 3000¢ per-campaign cap. ` +
    'Narrow the set or raise the cap deliberately.')
}

const jobKey = (stage: string, c: string, l: string) => [c, l, stage].join(':')

let queued = 0
for (const leadId of ids) {
  await db.query(
    `select graphile_worker.add_job($1, $2::json, null, null, $3, $4)`,
    ['registry:match', JSON.stringify({ campaignId, leadId }), 3,
     jobKey('registry:match', campaignId, leadId)])
  queued++
}

console.log(`\nenqueued ${queued} registry:match jobs`)
await db.end()
