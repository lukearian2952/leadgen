// Load the Census ZCTA→county crosswalk into `zip_county`, for every state.
//
// ── Why an authoritative file, when zip_county already had rows ──────────────
//
// `zip_county` was built from the registries themselves: each entity's mailing
// ZIP paired with the county it filed under, `weight` counting observations.
// That is a reasonable bootstrap and it is measurably wrong at the edges,
// because a filing address is not a location. Live examples from the NY rows:
//
//   07306 → Suffolk (weight 20)   07306 is Jersey City, New Jersey
//   10996 → Saratoga             10996 is West Point, Orange County
//   27603 → Bronx                27603 is Raleigh, North Carolina
//
// Those are registered-agent addresses, and a county scope built from them
// sends the reverse lookup to the wrong county.
//
// More pressingly, the derived approach cannot work for Florida at all: Sunbiz
// publishes city and ZIP but no county, so all 11,031,417 FL entities have
// `county = ''` and there is nothing to derive from. Florida is the state that
// most needs a county, being both whole-state and the largest registry we hold.
//
// ── The file ────────────────────────────────────────────────────────────────
//
//   www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/
//     tab20_zcta520_county20_natl.txt
//
// Pipe-delimited, ~6.8 MB, one row per ZCTA×county intersection. A ZCTA that
// straddles a county line appears once per county, and `AREALAND_PART` is the
// land area of that piece — which is the natural weight, and better than an
// observation count because it says *how much* of the ZIP is in the county.
//
// Rows with an empty ZCTA are county totals and are skipped.
//
// **ZCTA is not ZIP.** They are the Census Bureau's approximation of ZIP areas
// and they differ for PO-box-only and point ZIPs. For scoping a county search
// that is fine — the cost of a slightly wrong county is a missed match, not a
// wrong one — but it is the reason this table keeps a `source` column rather
// than overwriting what the registries observed.
//
// Usage:
//   npx tsx scripts/zip-county-load.ts            # all states
//   npx tsx scripts/zip-county-load.ts FL         # one state, for a quick check

import { registryPool } from './_db.js'

const URL =
  'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt'

/** Census state FIPS → USPS code. The registries key on the two-letter code. */
const FIPS_STATE: Record<string, string> = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE',
  '11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA',
  '20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN',
  '28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM',
  '36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA',
  '54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI',
}

/**
 * "Baldwin County" → "Baldwin", to match what the registries already store
 * ("Nassau", "Kings", "New York" — bare, no suffix).
 *
 * The suffix is not always "County": Louisiana files parishes, Alaska boroughs
 * and census areas, and Virginia has independent cities whose NAMELSAD ends in
 * a lowercase "city" that is part of the name's meaning, not decoration —
 * "Richmond city" is a different jurisdiction from "Richmond County", so that
 * one keeps its suffix and only the redundant ones are trimmed.
 */
export function bareCountyName(namelsad: string): string {
  return namelsad
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|Municipio)$/i, '')
    .trim()
}

async function main(): Promise<void> {
  const only = (process.argv[2] ?? '').toUpperCase() || null
  const db = registryPool(2)

  console.log(`fetching ${URL}`)
  const res = await fetch(URL, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`census HTTP ${res.status}`)
  const text = await res.text()
  console.log(`  ${(text.length / 1e6).toFixed(1)} MB`)

  const lines = text.split(/\r?\n/)
  const header = lines[0].replace(/^﻿/, '').split('|')
  const iZip = header.indexOf('GEOID_ZCTA5_20')
  const iCountyGeo = header.indexOf('GEOID_COUNTY_20')
  const iCountyName = header.indexOf('NAMELSAD_COUNTY_20')
  const iArea = header.indexOf('AREALAND_PART')
  if ([iZip, iCountyGeo, iCountyName, iArea].some(i => i < 0)) {
    throw new Error(`unexpected header: ${header.join('|')}`)
  }

  type Row = { zip: string; state: string; county: string; weight: number }
  const rows: Row[] = []
  let skippedNoZip = 0, skippedNoState = 0

  for (const line of lines.slice(1)) {
    if (!line) continue
    const f = line.split('|')
    const zip = (f[iZip] ?? '').trim()
    if (!zip) { skippedNoZip++; continue }

    const geo = (f[iCountyGeo] ?? '').trim()
    const state = FIPS_STATE[geo.slice(0, 2)]
    if (!state) { skippedNoState++; continue }
    if (only && state !== only) continue

    const county = bareCountyName((f[iCountyName] ?? '').trim())
    if (!county) continue

    // Land area in square metres. Scaled to km² so it fits an int comfortably
    // and still separates a ZIP's main county from a sliver, and floored at 1
    // so a genuinely tiny intersection still outranks nothing.
    const area = Number(f[iArea] ?? '0')
    const weight = Math.max(1, Math.round((Number.isFinite(area) ? area : 0) / 1e6))
    rows.push({ zip, state, county, weight })
  }

  console.log(`parsed ${rows.length} zip×county rows` +
              `  (skipped ${skippedNoZip} county-total rows, ${skippedNoState} unknown-FIPS)`)

  // Upsert in batches. `source = 'census'` distinguishes these from the rows
  // derived from registry filings, and county_for_zip prefers them.
  const BATCH = 1000
  let written = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = slice.map((r, j) => {
      values.push(r.zip, r.state, r.county, r.weight)
      const b = j * 4
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},'census')`
    })
    await db.query(
      `insert into zip_county (postal_code, state, county, weight, source)
       values ${tuples.join(',')}
       on conflict (postal_code, state, county) do update
         set weight = excluded.weight, source = 'census'`,
      values)
    written += slice.length
    if (written % 20000 === 0) console.log(`  ${written}/${rows.length}`)
  }

  const { rows: [summary] } = await db.query<{ census: string; registry: string; states: string }>(
    `select count(*) filter (where source = 'census')   census,
            count(*) filter (where source = 'registry') registry,
            count(distinct state)                        states
       from zip_county`)

  console.log(`\nwrote ${written}`)
  console.log(`zip_county now: ${summary.census} census, ${summary.registry} registry, ` +
              `${summary.states} states`)
  await db.end()
}

main().catch(err => { console.error(err); process.exit(1) })
