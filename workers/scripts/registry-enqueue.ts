// Enqueue a registry:ingest job.
//
// Uses `graphile_worker.add_job` in SQL over the transaction pooler rather than
// `makeWorkerUtils`, because the session-mode connection budget is ~15 project
// wide and seven workers already hold fourteen of them. See HANDOFF §2.
//
// Usage:
//   npx tsx scripts/registry-enqueue.ts <STATE> [niche] [mode]
//   npx tsx scripts/registry-enqueue.ts <STATE> --whole [mode]
//
//   mode is FL-only: 'quarterly' (the 1.8 GB snapshot) or 'daily' (recent
//   filings). A whole-state FL load needs 'quarterly' — the daily files are
//   five days of filings, not the state.
//
// ── --whole ──────────────────────────────────────────────────────────────────
//
// A niche-scoped slice cannot answer the reverse lookup: "is this person an
// officer of any nearby entity" has no answer in a table holding only
// wrap-named companies. NY loaded whole moved reverse matches from 1 to 50 —
// 28% of all matches — so this is a change in what the pipeline can do, not
// only in how much it finds. HANDOFF §5.1/§5.3.
//
// `wholeState` and `nameContains` are mutually exclusive and the job rejects
// the combination, so this flag clears the token list rather than adding to
// it.

import pg from 'pg'
import { nicheNameTokens } from '../src/jobs/registry-ingest.js'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 1,
})

const state = (process.argv[2] ?? '').toUpperCase()
const whole = process.argv[3] === '--whole'
const niche = whole ? '' : (process.argv[3] ?? 'car wrap')
const mode = whole ? process.argv[4] : process.argv[4]
if (!state) throw new Error('usage: registry-enqueue.ts <STATE> [niche|--whole] [mode]')

if (whole && state === 'FL' && mode !== 'quarterly') {
  throw new Error(
    "FL whole-state needs the quarterly snapshot: the daily files are a few " +
    "days of filings. Run: registry-enqueue.ts FL --whole quarterly")
}

const payload: Record<string, unknown> = whole
  // No nameContains: the job rejects it alongside wholeState, and the point of
  // a whole-state load is that there is no scope.
  ? { state, wholeState: true, keepRaw: false }
  : { state, nameContains: nicheNameTokens(niche) }
if (mode) payload.mode = mode

// One job per state at a time. `job_key` makes a re-run replace the queued job
// rather than stack a second full-state ingest behind the first — two
// concurrent FL quarterlies would mean 3.6 GB of download for one result.
const jobKey = `registry:ingest:${state}:${whole ? 'whole' : 'scoped'}:${mode ?? 'default'}`

const { rows } = await db.query(
  `select id, run_at from graphile_worker.add_job(
     $1, payload := $2::json, job_key := $3, max_attempts := 2)`,
  ['registry:ingest', JSON.stringify(payload), jobKey])

console.log(`enqueued ${jobKey}${whole ? '  (WHOLE STATE)' : ''}`)
console.log(`  job ${rows[0].id}, run_at ${rows[0].run_at}`)
console.log(`  payload ${JSON.stringify(payload)}`)
await db.end()
