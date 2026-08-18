// Per-batch byte drift guard for a long discovery run.
//
// The run is accepted at 1.62 MB per business discovered. If it drifts, the
// cheapest moment to find out is the batch it happens on — not 900 businesses
// later when the 2.5 GB cap trips and the campaign stops with no explanation.
//
// Two consecutive batches over the threshold, not one: a single bad batch is
// ordinary variance (a city with unusually heavy listings, a retry that
// re-rendered pages). Two in a row is a trend, and a trend is the thing worth
// interrupting a run for.
//
// The ratio is computed against businesses **discovered** (`returned`), which
// is the denominator the accepted 1.62 was measured on. `kept` is also printed
// because it is the business-relevant number, but drifting on a denominator
// other than the one the threshold was set on would compare two different
// things.
//
// Usage: npx tsx scripts/byte-drift.ts <campaignId> <outCsv> [thresholdMb]

import pg from 'pg'
import { appendFile, writeFile } from 'node:fs/promises'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const campaignId = process.argv[2]
const outCsv = process.argv[3]
const threshold = Number(process.argv[4] ?? 2.0)
if (!campaignId || !outCsv) throw new Error('usage: byte-drift.ts <campaignId> <outCsv> [mb]')

const HEADER = 'ts,batch,returned,kept,residential_mb,mb_per_discovered,mb_per_kept,over,consecutive\n'
await writeFile(outCsv, HEADER, 'utf8')

const seen = new Set<string>()
let consecutive = 0

console.log(`watching ${campaignId}; threshold ${threshold} MB/business discovered`)

for (;;) {
  const { rows } = await db.query<{
    id: string; batch: string | null; returned: string | null
    kept: string | null; mb: string | null; finished_at: Date
  }>(
    `select id::text,
            detail->>'batchIndex' batch,
            detail->>'returned'   returned,
            detail->>'kept'       kept,
            detail->>'residential_mb' mb,
            finished_at
       from job_runs
      where campaign_id = $1 and stage = 'maps:discover' and status = 'success'
        and detail->>'residential_mb' is not null
      order by finished_at`, [campaignId])

  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)

    const mb = Number(r.mb ?? 0)
    const returned = Number(r.returned ?? 0)
    const kept = Number(r.kept ?? 0)
    // A batch that discovered nothing has no ratio — it is a failed scrape, not
    // an expensive one, and dividing by zero would report Infinity and pause a
    // healthy run.
    const perDiscovered = returned > 0 ? mb / returned : null
    const perKept = kept > 0 ? mb / kept : null

    const over = perDiscovered !== null && perDiscovered > threshold
    consecutive = over ? consecutive + 1 : 0

    const line = [
      new Date().toISOString(), r.batch ?? '', returned, kept, mb.toFixed(1),
      perDiscovered?.toFixed(3) ?? '', perKept?.toFixed(3) ?? '',
      over ? 'yes' : 'no', consecutive,
    ].join(',') + '\n'
    await appendFile(outCsv, line, 'utf8')
    console.log(
      `batch ${r.batch}: ${mb.toFixed(1)} MB / ${returned} discovered = ` +
      `${perDiscovered?.toFixed(3) ?? '-'} MB each` +
      (over ? `  OVER ${threshold} (${consecutive} in a row)` : ''))

    if (consecutive >= 2) {
      // Pause by removing queued discovery and flipping status. Leaves
      // everything already discovered intact and resumable — discovery_city_runs
      // means a resume will not re-buy any city already scraped.
      await db.query(
        `delete from graphile_worker._private_jobs
          where task_id in (select id from graphile_worker._private_tasks
                             where identifier = 'maps:discover')`)
      await db.query(`update campaigns set status = 'paused' where id = $1`, [campaignId])
      console.log(`\nPAUSED: ${consecutive} consecutive batches over ${threshold} MB/business.`)
      console.log('Discovery jobs cleared; discovered leads retained and resumable.')
      await db.end()
      process.exit(2)
    }
  }

  const { rows: [c] } = await db.query<{ status: string }>(
    `select status from campaigns where id = $1`, [campaignId])
  if (c && c.status !== 'running') {
    console.log(`campaign status ${c.status} — drift guard exiting`)
    break
  }
  await new Promise(r => setTimeout(r, 60_000))
}
await db.end()
