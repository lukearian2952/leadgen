// What would the statewide reverse fallback add, on a campaign that ran
// without it?
//
// Measured read-only rather than by re-running registry:match, because the
// chain always continues to enrich:lead and would re-spend the Verifalia
// budget to answer a question about the registry. This replays exactly the
// two queries reverseLookup issues — county-scoped first, statewide only on a
// miss — and reports the extra hits, the extra queries, and the ambiguous
// names the bound rejects.
//
// Usage: npx tsx scripts/statewide-delta.ts <campaignId>

import pg from 'pg'
import { adjacentCounties } from '../src/lib/counties.js'
import type { NameCandidate } from '../src/lib/name-decision.js'

const STATEWIDE_MAX_ENTITIES = 2

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const campaignId = process.argv[2]
if (!campaignId) throw new Error('usage: statewide-delta.ts <campaignId>')

const { rows: leads } = await db.query<{
  id: string; business_name: string; county: string; owner_first_name: string
  evidence: Record<string, unknown>
}>(
  `select l.id, l.business_name, l.owner_first_name,
          coalesce(nullif(l.county,''), county_for_zip(b.postal_code,'NY'), '') county,
          l.evidence
     from leads l left join businesses b on b.id = l.business_id
    where l.campaign_id = $1`, [campaignId])

let checked = 0, countyHits = 0, statewideQueries = 0, statewideHits = 0, ambiguous = 0
const gained: string[] = []

for (const lead of leads) {
  const cands = (lead.evidence?.name_candidates as NameCandidate[] | undefined) ?? []
  const people = cands.filter(c => c.source === 'site_crawl' && c.first && c.last)
  const counties = adjacentCounties('NY', lead.county)

  for (const person of people) {
    checked++
    const officer = JSON.stringify([{ first: person.first, last: person.last }])

    const { rows: county } = await db.query(
      `select id from registry_entities
        where state='NY' and ($1::text[] = '{}' or county = any($1))
          and officers @> $2::jsonb limit 1`, [counties, officer])
    if (county.length) { countyHits++; continue }

    statewideQueries++
    const { rows: wide } = await db.query<{ id: string; name: string; county: string }>(
      `select id, name, county from registry_entities
        where state='NY' and officers @> $1::jsonb limit $2`,
      [officer, STATEWIDE_MAX_ENTITIES + 1])

    if (!wide.length) continue
    if (wide.length > STATEWIDE_MAX_ENTITIES) { ambiguous++; continue }

    statewideHits++
    // Only interesting when the lead had no name at all — otherwise the
    // statewide hit corroborates something already decided.
    if (!lead.owner_first_name) {
      gained.push(`${lead.business_name} → ${person.first} ${person.last} ` +
                  `(${wide[0].name}, ${wide[0].county})`)
    }
  }
}

console.log(`\ncampaign ${campaignId}`)
console.log(`  site people checked        ${checked}`)
console.log(`  county-scoped hits         ${countyHits}` +
            ` (${checked ? (100 * countyHits / checked).toFixed(1) : '0'}%)`)
console.log(`  statewide queries issued   ${statewideQueries}`)
console.log(`  statewide EXTRA hits       ${statewideHits}` +
            ` (${statewideQueries ? (100 * statewideHits / statewideQueries).toFixed(1) : '0'}% of misses)`)
console.log(`  rejected as common name    ${ambiguous}`)
console.log(`  would newly NAME a lead    ${gained.length}`)
for (const g of gained) console.log(`    - ${g}`)
console.log(`\n  cost: ${statewideQueries} extra indexed jsonb containment queries, $0 external.\n`)

await db.end()
