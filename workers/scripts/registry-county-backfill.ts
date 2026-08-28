// Backfill `registry_entities.county` from `postal_code`, via zip_county.
//
// Sunbiz publishes city and ZIP but no county, so all 11,031,417 Florida
// entities landed with `county = ''`. The reverse lookup scopes by county, and
// `registry_entities_scope` / `registry_entities_has_person` are both indexed
// on (state, county) — so an empty county does not merely lose precision, it
// makes those indexes useless for Florida and turns every reverse query into a
// statewide scan of the largest registry we hold.
//
// ── Batched by ZIP, and the equality has to stay indexable ───────────────────
//
// One `update … from zip_county` over 11M rows is a single transaction holding
// 11M row locks, writing several GB of WAL and leaving 10M dead tuples on a
// database already at 9.9 GB of a 20 GB cap. Iterating the ~1,200 ZIPs in a
// state keeps each statement to a few thousand rows and can be interrupted
// without losing committed work.
//
// **The predicate must match `registry_entities_zip (state, postal_code)`
// exactly.** The first version of this script compared
// `left(regexp_replace(postal_code,'[^0-9]','','g'),5) = $2`, which is a
// functional expression the index cannot serve: every one of the 1,174
// statements sequentially scanned 11M rows at ~44 seconds each — 14 hours for
// what is now minutes. 98.2% of Florida's postal codes are already exactly five
// characters, so plain equality does almost all the work on the index, and one
// mop-up pass afterwards handles the ~181k ZIP+4 and malformed rows in a single
// scan rather than 1,174 of them.
//
// Idempotent: only rows whose county is still empty are touched, so a re-run
// after an interruption resumes rather than redoing.
//
// Usage:
//   npx tsx scripts/registry-county-backfill.ts FL
//   npx tsx scripts/registry-county-backfill.ts FL --dry-run

import { registryPool } from './_db.js'

const state = (process.argv[2] ?? '').toUpperCase()
const dryRun = process.argv.includes('--dry-run')
if (!state) throw new Error('usage: registry-county-backfill.ts <STATE> [--dry-run]')

const db = registryPool(2)

async function main(): Promise<void> {
  const { rows: [before] } = await db.query<{ total: string; blank: string; with_zip: string }>(
    `select count(*) total,
            count(*) filter (where county = '') blank,
            count(*) filter (where county = '' and postal_code <> '') with_zip
       from registry_entities where state = $1`, [state])

  console.log(`${state}: ${before.total} entities, ${before.blank} with no county, ` +
              `${before.with_zip} of those carry a ZIP`)

  const { rows: zips } = await db.query<{ postal_code: string; county: string }>(
    `select postal_code, county from zip_county
      where state = $1 and source = 'census'
      order by postal_code`, [state])
  console.log(`${zips.length} census ZIPs for ${state}`)

  if (dryRun) {
    const { rows: [est] } = await db.query<{ n: string }>(
      `select count(*) n from registry_entities e
        where e.state = $1 and e.county = ''
          and exists (select 1 from zip_county z
                       where z.state = e.state and z.source = 'census'
                         and z.postal_code = left(regexp_replace(e.postal_code,'[^0-9]','','g'),5))`,
      [state])
    console.log(`dry run: ${est.n} rows would gain a county`)
    return
  }

  // ── pass 1: exact five-character codes, on the index ──────────────────────
  const t0 = Date.now()
  let updated = 0
  for (const [i, z] of zips.entries()) {
    const { rowCount } = await db.query(
      `update registry_entities
          set county = $3
        where state = $1
          and county = ''
          and postal_code = $2`,
      [state, z.postal_code, z.county])
    updated += rowCount ?? 0
    if ((i + 1) % 200 === 0) {
      const rate = (i + 1) / ((Date.now() - t0) / 1000)
      console.log(`  ${i + 1}/${zips.length} zips — ${updated} rows ` +
                  `(${rate.toFixed(1)} zips/s)`)
    }
  }
  console.log(`pass 1 (indexed equality): ${updated} rows in ` +
              `${Math.round((Date.now() - t0) / 1000)}s`)

  // ── pass 2: ZIP+4 and malformed, one scan ─────────────────────────────────
  //
  // Everything left with a county still empty and a postal code that is not a
  // bare five characters. One statement, one sequential scan, joined against
  // the crosswalk — worth a single scan, not 1,174.
  const t1 = Date.now()
  const { rowCount: mopped } = await db.query(
    `update registry_entities e
        set county = z.county
       from zip_county z
      where e.state = $1
        and e.county = ''
        and length(e.postal_code) <> 5
        and z.state = $1
        and z.source = 'census'
        and z.postal_code = left(regexp_replace(e.postal_code,'[^0-9]','','g'),5)`,
    [state])
  updated += mopped ?? 0
  console.log(`pass 2 (ZIP+4 mop-up): ${mopped} rows in ` +
              `${Math.round((Date.now() - t1) / 1000)}s`)

  const { rows: [after] } = await db.query<{ blank: string; counties: string }>(
    `select count(*) filter (where county = '') blank,
            count(distinct county) filter (where county <> '') counties
       from registry_entities where state = $1`, [state])

  console.log(`\nupdated ${updated} rows`)
  console.log(`${state} now: ${after.counties} distinct counties, ${after.blank} still blank`)
}

main().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
