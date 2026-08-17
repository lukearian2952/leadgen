// Sample a running campaign into a CSV, for throughput and queue-depth reporting.
//
// job_runs records when each job started and finished, so per-stage throughput
// is recoverable afterwards — but queue depth is a level, not an event, and is
// gone the moment it changes. This samples it.
//
// Usage: npx tsx scripts/sample-run.ts <campaignId> <outFile> [intervalSeconds]

import pg from 'pg'
import { appendFile, writeFile } from 'node:fs/promises'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const campaignId = process.argv[2]
const outFile = process.argv[3]
const intervalMs = Number(process.argv[4] ?? 120) * 1000
if (!campaignId || !outFile) throw new Error('usage: sample-run.ts <campaignId> <outFile> [seconds]')

const COLUMNS = [
  'ts', 'status', 'leads', 'crawled', 'named_stage', 'enriched', 'named',
  'tier_a', 'tier_b', 'tier_c', 'rejected',
  'queue_total', 'queue_runnable', 'queue_locked', 'dead_letter',
  'jobs_done', 'failed_jobs', 'spend_cents',
]

await writeFile(outFile, COLUMNS.join(',') + '\n', 'utf8')

// eslint-disable-next-line no-constant-condition
while (true) {
  const { rows: [r] } = await db.query<Record<string, string>>(
    `select
       (select status from campaigns where id = $1) status,
       (select count(*) from leads where campaign_id = $1) leads,
       (select count(*) from leads where campaign_id = $1 and crawl_done) crawled,
       (select count(*) from leads where campaign_id = $1 and name_done) named_stage,
       (select count(*) from leads where campaign_id = $1 and enrich_done) enriched,
       (select count(*) from leads where campaign_id = $1 and owner_first_name <> '') named,
       (select count(*) from leads where campaign_id = $1 and tier='A') tier_a,
       (select count(*) from leads where campaign_id = $1 and tier='B') tier_b,
       (select count(*) from leads where campaign_id = $1 and tier='C') tier_c,
       (select count(*) from leads where campaign_id = $1 and tier='rejected') rejected,
       (select count(*) from graphile_worker.jobs) queue_total,
       (select count(*) from graphile_worker.jobs
         where run_at <= now() and locked_at is null) queue_runnable,
       (select count(*) from graphile_worker.jobs where locked_at is not null) queue_locked,
       (select count(*) from dead_letter where campaign_id = $1) dead_letter,
       (select count(*) from job_runs where campaign_id = $1 and status='success') jobs_done,
       (select count(*) from job_runs where campaign_id = $1 and status='failed') failed_jobs,
       (select coalesce(round(sum(cost_cents)::numeric,2),0) from job_runs
         where campaign_id = $1) spend_cents`,
    [campaignId])

  const line = [new Date().toISOString(), ...COLUMNS.slice(1).map(c => r[c] ?? '')].join(',')
  await appendFile(outFile, line + '\n', 'utf8')
  process.stdout.write(line + '\n')

  if (['completed', 'completed_low_yield', 'failed'].includes(r.status ?? '')) break
  await new Promise(res => setTimeout(res, intervalMs))
}

await db.end()
