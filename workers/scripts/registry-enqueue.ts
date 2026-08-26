// Enqueue a registry:ingest job.
//
// Uses `graphile_worker.add_job` in SQL over the transaction pooler rather than
// `makeWorkerUtils`, because the session-mode connection budget is ~15 project
// wide and seven workers already hold fourteen of them. See HANDOFF §2.
//
// Usage: npx tsx scripts/registry-enqueue.ts <STATE> [niche] [mode]
//   mode is FL-only: 'quarterly' (whole state) or 'daily' (recent filings).

import pg from 'pg'
import { nicheNameTokens } from '../src/jobs/registry-ingest.js'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 1,
})

const state = (process.argv[2] ?? '').toUpperCase()
const niche = process.argv[3] ?? 'car wrap'
const mode = process.argv[4]
if (!state) throw new Error('usage: registry-enqueue.ts <STATE> [niche] [mode]')

const payload: Record<string, unknown> = {
  state,
  nameContains: nicheNameTokens(niche),
}
if (mode) payload.mode = mode

// One job per state at a time. `job_key` makes a re-run replace the queued job
// rather than stack a second full-state ingest behind the first — two
// concurrent FL quarterlies would mean 3.6 GB of download for one result.
const jobKey = `registry:ingest:${state}:${mode ?? 'default'}`

const { rows } = await db.query(
  `select id, run_at from graphile_worker.add_job(
     $1, payload := $2::json, job_key := $3, max_attempts := 2)`,
  ['registry:ingest', JSON.stringify(payload), jobKey])

console.log(`enqueued ${jobKey}`)
console.log(`  job ${rows[0].id}, run_at ${rows[0].run_at}`)
console.log(`  payload ${JSON.stringify(payload)}`)
await db.end()
