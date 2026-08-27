// What does the wider registry add, measured without spending anything?
//
// ── Why read-only rather than re-running the stage ───────────────────────────
//
// `registry:match` always ends by chaining to `serp:owner` or `enrich:lead`,
// and `enrich:lead` constructs candidate mailboxes and verifies them. Running
// the real stage over 1,042 leads to answer "did coverage improve" would spend
// the Verifalia budget on the question rather than on the answer, and would
// re-crawl nothing but would certainly re-verify.
//
// So this replays the two queries the stage issues — the forward trigram match
// and the reverse officer lookup, county-scoped then statewide — against the
// registry as it stands now, and reports what *would* be named. The queries are
// copied from `registry-match.ts` rather than imported because the stage's
// entry point is a graphile Task bound to a job context; the SQL is the part
// that matters and it is asserted identical by eye against that file.
//
// Verification of the names it finds is a separate, costed step. Prove the
// naming gain first; spend only on the leads that actually gained one.
//
// Usage: npx tsx scripts/registry-coverage-delta.ts <campaignId> [--json out.json]

import type { Pool } from 'pg'
import { appPool, registryPool } from './_db.js'
import { distinctiveTokens } from '../src/lib/normalise.js'
import { adjacentCounties } from '../src/lib/counties.js'

const MIN_SIMILARITY = 0.6
const GENERIC_NAME_MIN_SIMILARITY = 0.9
const STATEWIDE_MAX_ENTITIES = 2

// A campaign id, or `--state XX` to sweep every campaign's leads in one state.
const campaignId = process.argv[2]?.startsWith('--') ? null : process.argv[2]
const stateAt = process.argv.indexOf('--state')
const stateFilter = stateAt > 0 ? (process.argv[stateAt + 1] ?? '').toUpperCase() : null
if (!campaignId && !stateFilter) {
  throw new Error('usage: registry-coverage-delta.ts <campaignId>|--state XX [--json out]')
}
const jsonAt = process.argv.indexOf('--json')
const jsonOut = jsonAt > 0 ? process.argv[jsonAt + 1] : null

// Leads come from Supabase; every registry query goes to registry-db. There is
// no statement here that touches both.
const db: Pool = appPool(3)
const registryDb: Pool = registryPool(3)

// `GENERIC_FALLBACK` in registry-match.ts: tokens too common to narrow on.
const GENERIC_FALLBACK = new Set(['llc', 'inc', 'corp', 'company', 'co', 'the'])

interface Lead {
  id: string
  business_name: string
  state: string
  county: string
  city: string
  name_norm: string
  postal_code: string
  owner_first_name: string | null
  owner_source: string | null
  tier: string | null
}

const { rows: leads } = await db.query<Lead>(
  `select l.id, l.business_name,
          upper(coalesce(nullif(l.state,''), b.state, '')) state,
          coalesce(nullif(l.county,''), '') county,
          coalesce(nullif(l.city,''), b.city, '') city,
          coalesce(nullif(b.name_norm,''), lower(l.business_name)) name_norm,
          coalesce(b.postal_code, '') postal_code,
          nullif(l.owner_first_name,'') owner_first_name,
          l.owner_source, l.tier
     from leads l left join businesses b on b.id = l.business_id
    where ($1::uuid is null or l.campaign_id = $1)
      and ($2::text is null
           or upper(coalesce(nullif(l.state,''), b.state, '')) = $2)
    order by 3, 2`, [campaignId, stateFilter])

console.log(
  campaignId ? `campaign ${campaignId}: ${leads.length} leads\n`
             : `state ${stateFilter}: ${leads.length} leads across all campaigns\n`)

/** States the registry actually holds rows for right now. */
const { rows: loaded } = await registryDb.query<{ state: string; n: string }>(
  `select state, count(*) n from registry_entities group by 1 order by 1`)
const coverage = new Map(loaded.map(r => [r.state, Number(r.n)]))
console.log('registry_entities: ' +
  [...coverage.entries()].map(([s, n]) => `${s}=${n.toLocaleString()}`).join(' '))

interface Row { state: string; total: number; namedBefore: number; namedAfter: number
                forward: number; reverseCounty: number; reverseStatewide: number
                gained: Array<{ id: string; name: string; via: string }> }
const byState = new Map<string, Row>()
const rowFor = (s: string): Row => {
  let r = byState.get(s)
  if (!r) {
    r = { state: s, total: 0, namedBefore: 0, namedAfter: 0,
          forward: 0, reverseCounty: 0, reverseStatewide: 0, gained: [] }
    byState.set(s, r)
  }
  return r
}

let processed = 0
for (const lead of leads) {
  const row = rowFor(lead.state || '??')
  row.total++
  const namedBefore = Boolean(lead.owner_first_name)
  if (namedBefore) row.namedBefore++

  if (!coverage.has(lead.state)) {
    if (namedBefore) row.namedAfter++
    continue
  }

  const county = await resolveCounty(lead)
  let found: 'forward' | 'county' | 'statewide' | null = null

  // ── forward ────────────────────────────────────────────────────────────────
  const best = await bestMatch(lead, county)
  if (best && (best.officers ?? []).some(o => o.kind === 'person' && o.first)) {
    found = 'forward'
    row.forward++
  }

  // ── reverse ────────────────────────────────────────────────────────────────
  // Keyed on a person the crawl already named, so it costs no new crawling.
  if (!found) {
    const people = await sitePeople(lead.id)
    for (const person of people) {
      const officerJson = JSON.stringify([{ first: person.first, last: person.last }])
      const counties = adjacentCounties(lead.state, county)
      const { rows: countyRows } = await registryDb.query(
        `select id from registry_entities
          where state = $1 and ($2::text[] = '{}' or county = any($2))
            and officers @> $3::jsonb limit 3`,
        [lead.state, counties, officerJson])

      if (countyRows.length) { found = 'county'; row.reverseCounty++; break }

      const { rows: wide } = await registryDb.query(
        `select id from registry_entities
          where state = $1 and officers @> $2::jsonb limit $3`,
        [lead.state, officerJson, STATEWIDE_MAX_ENTITIES + 1])
      if (wide.length && wide.length <= STATEWIDE_MAX_ENTITIES) {
        found = 'statewide'; row.reverseStatewide++; break
      }
    }
  }

  const namedAfter = namedBefore || Boolean(found)
  if (namedAfter) row.namedAfter++
  if (!namedBefore && found) {
    row.gained.push({ id: lead.id, name: lead.business_name, via: found })
  }

  if (++processed % 100 === 0) process.stderr.write(`  …${processed}/${leads.length}\n`)
}

// ── report ───────────────────────────────────────────────────────────────────

const all = [...byState.values()].sort((a, b) => b.total - a.total)
const totals = all.reduce((acc, r) => ({
  total: acc.total + r.total,
  namedBefore: acc.namedBefore + r.namedBefore,
  namedAfter: acc.namedAfter + r.namedAfter,
  forward: acc.forward + r.forward,
  reverseCounty: acc.reverseCounty + r.reverseCounty,
  reverseStatewide: acc.reverseStatewide + r.reverseStatewide,
}), { total: 0, namedBefore: 0, namedAfter: 0, forward: 0, reverseCounty: 0, reverseStatewide: 0 })

console.log('\nstate  n     registry  named→  named←   Δ    fwd  rev-co  rev-st')
console.log('─'.repeat(72))
for (const r of all) {
  const cov = coverage.get(r.state)
  console.log(
    `${r.state.padEnd(6)} ${String(r.total).padEnd(5)} ` +
    `${(cov ? cov.toLocaleString() : '—').padEnd(9)} ` +
    `${String(r.namedBefore).padEnd(7)} ${String(r.namedAfter).padEnd(8)} ` +
    `${(r.namedAfter - r.namedBefore > 0 ? '+' : '') + (r.namedAfter - r.namedBefore)}`.padEnd(5) +
    ` ${String(r.forward).padEnd(4)} ${String(r.reverseCounty).padEnd(7)} ${r.reverseStatewide}`)
}
console.log('─'.repeat(72))
console.log(
  `TOTAL  ${String(totals.total).padEnd(5)} ${''.padEnd(9)} ` +
  `${String(totals.namedBefore).padEnd(7)} ${String(totals.namedAfter).padEnd(8)} ` +
  `+${totals.namedAfter - totals.namedBefore}`.padEnd(5) +
  ` ${String(totals.forward).padEnd(4)} ${String(totals.reverseCounty).padEnd(7)} ${totals.reverseStatewide}`)

console.log(`\nnamed-rate before: ${pct(totals.namedBefore, totals.total)}`)
console.log(`named-rate after:  ${pct(totals.namedAfter, totals.total)}`)

if (jsonOut) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(jsonOut, JSON.stringify({
    campaignId, totals, states: all,
    // The leads that gain a name. Re-running `registry:match` on only these
    // bounds the verification spend to the rows whose answer can actually
    // change — the other 991 keep the tier they already have, by definition.
    gainedIds: all.flatMap(r => r.gained.map(g => g.id)),
  }, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}

await db.end()
await registryDb.end()

// ── the replayed queries ─────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(1)}%` : '—'
}

async function resolveCounty(lead: Lead): Promise<string> {
  if (lead.county) return lead.county
  if (lead.postal_code && lead.state) {
    const { rows } = await registryDb.query<{ county: string | null }>(
      `select county_for_zip($1,$2) county`, [lead.postal_code, lead.state])
    if (rows[0]?.county) return rows[0].county
  }
  return ''
}

async function sitePeople(leadId: string): Promise<Array<{ first: string; last: string }>> {
  // Candidates live in `leads.evidence.name_candidates` — see readNameState.
  const { rows } = await db.query<{ candidates: unknown }>(
    `select evidence->'name_candidates' candidates from leads where id = $1`, [leadId])
  const raw = rows[0]?.candidates
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((c): c is { source: string; first: string; last: string } =>
      Boolean(c && typeof c === 'object' && (c as { source?: string }).source === 'site_crawl'
              && (c as { first?: string }).first && (c as { last?: string }).last))
    .map(c => ({ first: c.first, last: c.last }))
}

interface MatchRow { id: string; officers: Array<{ kind: string; first: string }> }

async function bestMatch(lead: Lead, county: string): Promise<MatchRow | null> {
  const tokens = distinctiveTokens(lead.business_name, 3)
    .filter(t => !GENERIC_FALLBACK.has(t))

  const params: unknown[] = [lead.state, lead.name_norm, county, MIN_SIMILARITY, lead.postal_code]
  let guard: string

  if (tokens.length) {
    const clauses = tokens.map(t => {
      params.push(`%${t}%`)
      return `name_norm like $${params.length}`
    })
    guard = `(${clauses.join(' or ')})`
  } else {
    params.push(GENERIC_NAME_MIN_SIMILARITY)
    guard =
      `similarity(name_norm, $2) >= $${params.length}
       and left(regexp_replace(postal_code,'[^0-9]','','g'),5)
         = left(regexp_replace($5,'[^0-9]','','g'),5)
       and $5 <> ''`
  }

  const { rows } = await registryDb.query<MatchRow>(
    `select id, officers
       from registry_entities
      where state = $1
        and ($3 = '' or county = '' or county = $3)
        and name_norm % $2
        and similarity(name_norm, $2) >= $4
        and ${guard}
      order by (left(regexp_replace(postal_code,'[^0-9]','','g'),5)
                 = left(regexp_replace($5,'[^0-9]','','g'),5)) desc,
               (officers <> '[]'::jsonb) desc,
               similarity(name_norm, $2) desc
      limit 5`,
    params)
  return rows[0] ?? null
}
