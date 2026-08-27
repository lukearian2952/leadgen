// Move `registry_entities` and `zip_county` from Supabase into registry-db.
//
// ── Why a script rather than pg_dump | psql ──────────────────────────────────
//
// Two reasons. The Supabase side is only reachable through the pooler, which
// does not support `COPY TO STDOUT` on a pooled connection; and this needs to
// verify as it goes rather than at the end, because a partial copy that nobody
// notices is worse than a failed one — every coverage number afterwards would
// be quietly low.
//
// Batched by keyset on `(state, entity_id)`, which is the unique index, so the
// paging is stable even though the source is being read while live jobs could
// theoretically write to it. OFFSET paging over 300k rows would also drift.
//
// Idempotent: every insert is an upsert on the same unique key the source uses,
// so a re-run repairs a partial migration rather than duplicating it.
//
// Usage:
//   npx tsx scripts/registry-migrate.ts verify   # counts on both sides
//   npx tsx scripts/registry-migrate.ts copy     # copy, then verify
//   npx tsx scripts/registry-migrate.ts drop     # drop the Supabase copy

import type { Pool } from 'pg'
import { appPool, registryPool } from './_db.js'

const command = process.argv[2] ?? 'verify'
const BATCH = 2_000

const app: Pool = appPool(2)
const registry: Pool = registryPool(2)

async function counts(): Promise<{
  srcEntities: number; dstEntities: number; srcZip: number; dstZip: number
}> {
  // The source tables may already be gone if `drop` has run; report 0 rather
  // than throwing, so `verify` stays useful after the cutover.
  const srcEntities = await countOf(app, 'registry_entities')
  const srcZip = await countOf(app, 'zip_county')
  const dstEntities = await countOf(registry, 'registry_entities')
  const dstZip = await countOf(registry, 'zip_county')
  return { srcEntities, dstEntities, srcZip, dstZip }
}

async function countOf(db: Pool, table: string): Promise<number> {
  try {
    const { rows } = await db.query<{ n: string }>(`select count(*) n from ${table}`)
    return Number(rows[0]?.n ?? 0)
  } catch (err) {
    if (/does not exist/i.test((err as Error).message)) return -1
    throw err
  }
}

function report(c: Awaited<ReturnType<typeof counts>>): boolean {
  const show = (n: number) => (n < 0 ? '(table dropped)' : n.toLocaleString())
  console.log('\n                    supabase        registry-db')
  console.log(`registry_entities   ${show(c.srcEntities).padEnd(15)} ${show(c.dstEntities)}`)
  console.log(`zip_county          ${show(c.srcZip).padEnd(15)} ${show(c.dstZip)}`)

  const entitiesOk = c.srcEntities < 0 || c.srcEntities === c.dstEntities
  const zipOk = c.srcZip < 0 || c.srcZip === c.dstZip
  console.log(`\nrow counts match: ${entitiesOk && zipOk ? 'YES' : 'NO'}`)
  return entitiesOk && zipOk
}

if (command === 'verify') {
  report(await counts())
  await Promise.all([app.end(), registry.end()])
  process.exit(0)
}

if (command === 'copy') {
  console.log('copying registry_entities…')

  // Keyset paging on the unique index. `where (state, entity_id) > (…)` uses
  // row comparison, which Postgres can drive straight off `registry_entities_uniq`.
  let lastState = ''
  let lastId = ''
  let copied = 0
  const started = Date.now()

  for (;;) {
    const { rows } = await app.query(
      `select state, entity_id, name, name_norm, status, entity_type,
              county, city, state_code, postal_code, street, filing_date,
              officers, raw, ingested_at
         from registry_entities
        where (state, entity_id) > ($1, $2)
        order by state, entity_id
        limit $3`,
      [lastState, lastId, BATCH])

    if (!rows.length) break

    const cols = 15
    const values: unknown[] = []
    const tuples = rows.map((r, i) => {
      const p = (n: number) => `$${i * cols + n}`
      values.push(
        r.state, r.entity_id, r.name, r.name_norm, r.status, r.entity_type,
        r.county, r.city, r.state_code, r.postal_code, r.street, r.filing_date,
        JSON.stringify(r.officers), JSON.stringify(r.raw), r.ingested_at)
      return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},` +
             `${p(9)},${p(10)},${p(11)},${p(12)}::date,${p(13)}::jsonb,${p(14)}::jsonb,${p(15)}::timestamptz)`
    })

    await registry.query(
      `insert into registry_entities
         (state, entity_id, name, name_norm, status, entity_type,
          county, city, state_code, postal_code, street, filing_date,
          officers, raw, ingested_at)
       values ${tuples.join(',')}
       on conflict (state, entity_id) do update
         set name = excluded.name, name_norm = excluded.name_norm,
             status = excluded.status, entity_type = excluded.entity_type,
             county = excluded.county, city = excluded.city,
             state_code = excluded.state_code, postal_code = excluded.postal_code,
             street = excluded.street, filing_date = excluded.filing_date,
             officers = excluded.officers, raw = excluded.raw,
             ingested_at = excluded.ingested_at`,
      values)

    const last = rows[rows.length - 1]
    lastState = last.state
    lastId = last.entity_id
    copied += rows.length
    process.stdout.write(`\r  ${copied.toLocaleString()} rows`)
  }

  console.log(`\n  done in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  console.log('copying zip_county…')
  const { rows: zips } = await app.query(
    `select postal_code, state, county, weight from zip_county`)
  for (let i = 0; i < zips.length; i += BATCH) {
    const chunk = zips.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = chunk.map((r, j) => {
      values.push(r.postal_code, r.state, r.county, r.weight)
      return `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4}::int)`
    })
    await registry.query(
      `insert into zip_county (postal_code, state, county, weight)
       values ${tuples.join(',')}
       on conflict (postal_code, state, county)
         do update set weight = greatest(zip_county.weight, excluded.weight)`,
      values)
  }
  console.log(`  ${zips.length.toLocaleString()} rows`)

  // ANALYZE, not VACUUM: the tables are new and have never had a dead tuple,
  // but the planner has no statistics at all until this runs — and without them
  // it will sequential-scan 304k rows instead of using the trigram index.
  console.log('analyzing…')
  await registry.query('analyze registry_entities')
  await registry.query('analyze zip_county')

  const ok = report(await counts())
  await Promise.all([app.end(), registry.end()])
  process.exit(ok ? 0 : 1)
}

if (command === 'drop') {
  const c = await counts()
  if (!report(c)) {
    throw new Error('row counts do not match — refusing to drop the Supabase copy')
  }
  if (c.dstEntities <= 0) {
    throw new Error('registry-db is empty — refusing to drop the Supabase copy')
  }

  const before = await app.query<{ mb: string; tbl: string }>(
    `select round(pg_database_size(current_database())/1048576.0) mb,
            pg_size_pretty(
              pg_total_relation_size('registry_entities')
              + pg_total_relation_size('zip_county')) tbl`)
  console.log(`\nsupabase before: ${before.rows[0].mb} MB (registry tables: ${before.rows[0].tbl})`)

  // `county_for_zip` goes with the table it reads; leaving a function behind
  // that queries a dropped table is a trap for the next person.
  await app.query('drop function if exists public.note_zip_county(text, text, text)')
  await app.query('drop function if exists public.county_for_zip(text, text)')
  await app.query('drop table if exists public.registry_entities')
  await app.query('drop table if exists public.zip_county')

  // VACUUM FULL is what actually returns the space to the filesystem; a plain
  // DROP frees pages inside the database without shrinking it. It takes an
  // exclusive lock, which is fine here because nothing else references these.
  await app.query('vacuum full analyze')

  const after = await app.query<{ mb: string }>(
    `select round(pg_database_size(current_database())/1048576.0) mb`)
  const reclaimed = Number(before.rows[0].mb) - Number(after.rows[0].mb)
  console.log(`supabase after:  ${after.rows[0].mb} MB`)
  console.log(`reclaimed:       ${reclaimed} MB`)

  await Promise.all([app.end(), registry.end()])
  process.exit(0)
}

throw new Error(`unknown command "${command}" — expected verify | copy | drop`)
