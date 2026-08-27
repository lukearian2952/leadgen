// Seed `registry_ingest_runs` in registry-db from Supabase's `job_runs`.
//
// One-time, for the cutover. `registry:ingest` writes this table itself from
// now on; this exists because the five states already loaded were ingested
// before the table existed, and `registry:refresh` reads it — an empty table
// means the weekly refresh silently stops refreshing anything.
//
// ── The FL correction ────────────────────────────────────────────────────────
//
// `job_runs.detail` never carried `mode`: the ingest's cost payload simply did
// not include it. So the mode read back for FL is null, and a refresh honouring
// that would replace a whole-state quarterly slice with five business days of
// daily filings — quietly, and only visible as a state that mysteriously
// stopped matching. FL is therefore forced to 'quarterly' here, and the ingest
// now records `mode` so no future backfill needs to know this.

import { appPool, registryPool } from './_db.js'

const app = appPool(1)
const registry = registryPool(1)

/** States whose slice is a whole-state archive rather than a daily delta. */
const QUARTERLY_STATES = new Set(['FL'])

const { rows } = await app.query<{
  state: string; adapter: string | null; mode: string | null
  name_contains: string[] | null
  seen: string; written: string; with_person: string; skipped: string
  complete: boolean
}>(
  `select distinct on (detail->>'state')
          detail->>'state' state, detail->>'adapter' adapter, detail->>'mode' mode,
          detail->'name_contains' name_contains,
          coalesce((detail->>'seen')::bigint,0) seen,
          coalesce((detail->>'written')::bigint,0) written,
          coalesce((detail->>'with_person')::bigint,0) with_person,
          coalesce((detail->>'skipped_anonymous')::bigint,0) skipped,
          coalesce((detail->>'complete')::boolean,true) complete
     from job_runs
    where stage='registry:ingest' and detail->>'state' is not null
    order by detail->>'state', finished_at desc`)

for (const r of rows) {
  const state = r.state.toUpperCase()
  const mode = r.mode ?? (QUARTERLY_STATES.has(state) ? 'quarterly' : null)
  await registry.query(
    `insert into registry_ingest_runs
       (state, adapter, mode, name_contains, seen, written, with_person,
        skipped_anonymous, complete)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (state) do update
       set adapter = excluded.adapter, mode = excluded.mode,
           name_contains = excluded.name_contains, seen = excluded.seen,
           written = excluded.written, with_person = excluded.with_person,
           skipped_anonymous = excluded.skipped_anonymous,
           complete = excluded.complete, finished_at = now()`,
    [state, r.adapter ?? '', mode, r.name_contains ?? [],
     r.seen, r.written, r.with_person, r.skipped, r.complete])
  console.log(`  ${state.padEnd(3)} mode=${mode ?? 'daily/default'} tokens=${(r.name_contains ?? []).length} written=${r.written}`)
}

const { rows: check } = await registry.query<{ state: string; mode: string | null }>(
  `select state, mode from registry_ingest_runs order by state`)
console.log(`\nregistry_ingest_runs: ${check.length} states`)

await Promise.all([app.end(), registry.end()])
