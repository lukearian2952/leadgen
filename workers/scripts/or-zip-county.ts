// Load Oregon's own ZIP→county crosswalk.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// `registry:match` keys on (normalised name, county) and scopes the reverse
// officer lookup to a county plus its neighbours, because a full-name match
// statewide is a common name rather than an identification. A Google Maps
// business has a ZIP and a town and never a county, so `zip_county` is what
// bridges the two.
//
// Normally that table is a by-product of ingest: every entity carries a ZIP and
// a county, and `upsertEntities` tallies the pairs. Oregon breaks that, because
// the entity dataset (`tckn-sxa6`) publishes **no county column at all** — so
// every OR entity lands with `county = ''`, the county-scoped reverse lookup
// has nothing to match, and every OR lookup falls through to the statewide
// fallback, which is bounded at two entities and rejects anything more common.
//
// Oregon publishes the county separately, in `6g49-bcrm` ("Active Businesses -
// County Data"), keyed by the same registry number and carrying `zip` and
// `county`. Aggregated upstream that is **496 (zip, county) pairs** — one
// request, and it makes the county scope work for OR the way it already works
// for NY.
//
// Run after an OR ingest, and on the same weekly cadence.
//
// Usage: npx tsx scripts/or-zip-county.ts [--apply]

import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const ENDPOINT = 'https://data.oregon.gov/resource/6g49-bcrm.json'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 1,
})

const url = new URL(ENDPOINT)
url.searchParams.set('$select', 'zip,county,count(1)')
url.searchParams.set('$group', 'zip,county')
url.searchParams.set('$limit', '50000')

const headers: Record<string, string> = { Accept: 'application/json' }
if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN

const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
if (!res.ok) throw new Error(`oregon county data: HTTP ${res.status}`)
const raw = await res.json() as Array<{ zip?: string; county?: string; count_1?: string }>

/**
 * A county name, or null.
 *
 * The published dataset carries `ERROR: #N/A` in the county column for some
 * ZIPs — a spreadsheet error string that survived into the state's own
 * release. Stored unfiltered it becomes a county named "ERROR: #N/A", every
 * lead in those ZIPs is assigned to it, and the county-scoped lookup then
 * misses *and* looks like it worked. Letters, spaces, hyphens and apostrophes
 * only, which admits "De Schutes" and "O'Brien" shapes and rejects that.
 */
function cleanCounty(value: string): string | null {
  const county = value.trim()
  if (!county) return null
  if (!/^[A-Za-z][A-Za-z '’.-]*$/.test(county)) return null
  return county
}

// Oregon writes counties title-cased ("Multnomah"), which is how `counties.ts`
// and the NY ingest spell them. Keep that; a case mismatch would silently make
// every county lookup miss.
const rows = raw
  .map(r => ({
    zip: (r.zip ?? '').replace(/\D/g, '').slice(0, 5),
    county: cleanCounty(r.county ?? ''),
    weight: Number(r.count_1 ?? 0),
  }))
  .filter((r): r is { zip: string; county: string; weight: number } =>
    r.zip.length === 5 && r.county !== null && r.weight > 0)

const counties = new Set(rows.map(r => r.county))
console.log(`oregon: ${raw.length} pairs upstream, ${rows.length} usable`)
console.log(`distinct counties: ${counties.size}`)
console.log(`distinct zips:     ${new Set(rows.map(r => r.zip)).size}`)
console.log(`rejected pairs:    ${raw.length - rows.length}`)

// Oregon has 36 counties. A crosswalk that produces a different number is
// reading something other than a county, and that is worth failing on rather
// than storing — the whole value of this table is that a name in it is a name
// `registry:match` can scope by.
const OREGON_COUNTIES = 36
if (counties.size !== OREGON_COUNTIES) {
  throw new Error(
    `expected ${OREGON_COUNTIES} Oregon counties and found ${counties.size}: ` +
    `${[...counties].sort().join(', ')}`)
}

const before = await db.query<{ n: string }>(
  "select count(*) n from zip_county where state = 'OR'")
console.log(`zip_county OR rows before: ${before.rows[0].n}`)

if (!APPLY) {
  console.log('\ndry run — pass --apply to write')
  console.log(rows.slice(0, 8).map(r => `  ${r.zip} ${r.county} (${r.weight})`).join('\n'))
  await db.end()
  process.exit(0)
}

// One statement: 496 rows at a round trip each would be a minute of
// bookkeeping for something that should take a second.
const values: unknown[] = []
const tuples = rows.map((r, i) => {
  values.push(r.zip, 'OR', r.county, r.weight)
  return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4}::int)`
})

// `weight = greatest(...)` rather than `+`, because this is an authoritative
// statewide count and re-running the script must be idempotent. The ingest path
// accumulates because each batch sees a different slice; this sees all of them.
await db.query(
  `insert into zip_county (postal_code, state, county, weight)
   values ${tuples.join(',')}
   on conflict (postal_code, state, county)
     do update set weight = greatest(zip_county.weight, excluded.weight)`,
  values,
)

const after = await db.query<{ n: string }>(
  "select count(*) n from zip_county where state = 'OR'")
console.log(`zip_county OR rows after:  ${after.rows[0].n}`)
await db.end()
