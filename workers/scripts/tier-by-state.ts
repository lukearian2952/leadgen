// Tier breakdown per state for a campaign, with an optional "before" overlay.
//
// The before/after this reports is not two snapshots taken at two times — the
// first one was never captured, because nobody knew which rows were about to
// change. It is reconstructed instead, which is exact rather than approximate:
// `registry-coverage-delta.ts` recorded the 51 lead ids that gained a name, and
// every one of those 51 was `rejected` beforehand (verified at the time). So
// "before" is today's table with those ids forced back to rejected.
//
// Usage:
//   npx tsx scripts/tier-by-state.ts <campaignId> [gained-ids.json]

import pg from 'pg'
import { readFileSync } from 'node:fs'

const campaignId = process.argv[2]
if (!campaignId) throw new Error('usage: tier-by-state.ts <campaignId> [ids.json]')
const idsFile = process.argv[3]

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
  connectionTimeoutMillis: 10_000, query_timeout: 60_000,
})

/** Lead ids whose "before" tier was `rejected`, if a delta file was given. */
const changed = new Set<string>(
  idsFile ? (JSON.parse(readFileSync(idsFile, 'utf8')) as { gainedIds?: string[] }).gainedIds ?? []
          : [])

interface Row {
  id: string
  state: string
  tier: string | null
  gate_passed: boolean
  email_status: string | null
}

const { rows } = await db.query<Row>(
  `select l.id,
          upper(coalesce(nullif(l.state,''), b.state, '??')) state,
          l.tier, l.gate_passed, l.email_status
     from leads l left join businesses b on b.id = l.business_id
    where l.campaign_id = $1`, [campaignId])

type Counts = { A: number; B: number; C: number; rejected: number }
const zero = (): Counts => ({ A: 0, B: 0, C: 0, rejected: 0 })
const tierOf = (r: Row): keyof Counts =>
  (r.tier as keyof Counts) ?? (r.gate_passed ? 'A' : 'rejected')

const before = new Map<string, Counts>()
const after = new Map<string, Counts>()
const totals = new Map<string, number>()

for (const r of rows) {
  const s = r.state
  if (!before.has(s)) { before.set(s, zero()); after.set(s, zero()) }
  totals.set(s, (totals.get(s) ?? 0) + 1)

  const now = tierOf(r)
  after.get(s)![now]++
  // Every gained lead was `rejected` before the registry expansion.
  before.get(s)![changed.has(r.id) ? 'rejected' : now]++
}

const states = [...totals.entries()].sort((a, b) => b[1] - a[1])
const sum = (c: Counts) => c.A + c.B
const line = '─'.repeat(78)

console.log(`campaign ${campaignId}: ${rows.length} leads`)
if (idsFile) console.log(`overlay: ${changed.size} leads were 'rejected' before\n`)

console.log('state   n     A→  A←   B→  B←   C→  C←    A+B→  A+B←   Δ')
console.log(line)

const tb = zero(), ta = zero()
let tn = 0
for (const [state, n] of states) {
  const b = before.get(state)!, a = after.get(state)!
  tn += n
  for (const k of ['A', 'B', 'C', 'rejected'] as const) { tb[k] += b[k]; ta[k] += a[k] }
  if (sum(b) === 0 && sum(a) === 0 && b.C === 0 && a.C === 0) continue
  const d = sum(a) - sum(b)
  console.log(
    `${state.padEnd(7)} ${String(n).padEnd(5)} ` +
    `${String(b.A).padEnd(3)} ${String(a.A).padEnd(4)} ` +
    `${String(b.B).padEnd(3)} ${String(a.B).padEnd(4)} ` +
    `${String(b.C).padEnd(3)} ${String(a.C).padEnd(5)} ` +
    `${String(sum(b)).padEnd(5)} ${String(sum(a)).padEnd(6)} ` +
    `${d > 0 ? '+' : ''}${d}`)
}

console.log(line)
const d = sum(ta) - sum(tb)
console.log(
  `TOTAL   ${String(tn).padEnd(5)} ` +
  `${String(tb.A).padEnd(3)} ${String(ta.A).padEnd(4)} ` +
  `${String(tb.B).padEnd(3)} ${String(ta.B).padEnd(4)} ` +
  `${String(tb.C).padEnd(3)} ${String(ta.C).padEnd(5)} ` +
  `${String(sum(tb)).padEnd(5)} ${String(sum(ta)).padEnd(6)} ` +
  `${d > 0 ? '+' : ''}${d}`)

const pct = (n: number) => `${((n / tn) * 100).toFixed(1)}%`
console.log(`\nsendable before: ${sum(tb)} (${pct(sum(tb))})`)
console.log(`sendable after:  ${sum(ta)} (${pct(sum(ta))})`)

// How many rows are still unverified — the number that says whether the
// verification actually ran or merely finished.
const unverified = rows.filter(r =>
  tierOf(r) === 'C' && (r.email_status === 'unknown' || !r.email_status)).length
console.log(`\nTier C still unverified (email_status unknown): ${unverified}`)

await db.end()
