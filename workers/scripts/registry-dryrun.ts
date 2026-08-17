// Dry run: ingest the NY slice for Long Island med spas, then match the 75
// businesses from campaign fd23a9e1 against it. Uses the real adapters.
import pg from 'pg'
import { NyRegistry } from '../src/sources/registry/ny.js'
import { upsertEntities } from '../src/sources/registry/index.js'
import { nicheNameTokens } from '../src/jobs/registry-ingest.js'
import { distinctiveTokens } from '../src/lib/normalise.js'
import { rootLogger } from '../src/logger.js'

const CAMPAIGN = 'fd23a9e1-a5d9-4dd7-91a1-babcc0179e96'
const COUNTIES = ['Nassau', 'Suffolk']

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL_DIRECT,
  ssl: { rejectUnauthorized: false }, max: 4,
})
const logger = rootLogger.child({ stage: 'dryrun' })
const ny = new NyRegistry(process.env.SOCRATA_APP_TOKEN ?? '', logger)

// ── 1. bulk slice ────────────────────────────────────────────────────────────
const tokens = nicheNameTokens('med spa')
console.log('niche tokens:', tokens.join(', '))
const total = await ny.count({ counties: COUNTIES, nameContains: tokens })
console.log(`NY entities in ${COUNTIES.join('+')} matching those tokens: ${total}`)

let batch = []
let seen = 0, written = 0, withPerson = 0
if (process.env.SKIP_INGEST) {
  const { rows } = await db.query(
    `select count(*)::int n, count(*) filter (where officers <> '[]'::jsonb)::int p
       from registry_entities where state='NY'`)
  seen = rows[0].n; written = rows[0].n; withPerson = rows[0].p
}
for await (const e of process.env.SKIP_INGEST ? [] : ny.ingest({ counties: COUNTIES, nameContains: tokens, limit: 60000 })) {
  batch.push(e)
  if (batch.length >= 500) {
    const s = await upsertEntities(db, batch)
    seen += s.seen; written += s.written; withPerson += s.withPerson
    batch = []
    if (seen % 5000 === 0) console.log(`  ingested ${seen}…`)
  }
}
if (batch.length) {
  const s = await upsertEntities(db, batch)
  seen += s.seen; written += s.written; withPerson += s.withPerson
}
console.log(`\nBULK: seen=${seen} written=${written} with_person=${withPerson} (${(withPerson / Math.max(seen,1) * 100).toFixed(1)}%)`)

// ── 2. match the 75 ──────────────────────────────────────────────────────────
const { rows: leads } = await db.query(`
  select l.id, l.business_name, l.city, coalesce(b.name_norm,'') name_norm,
         coalesce(b.postal_code,'') postal_code
    from leads l left join businesses b on b.id = l.business_id
   where l.campaign_id = $1 order by l.business_name`, [CAMPAIGN])

let matched = 0, named = 0, toppedUp = 0, matchedAfterTopUp = 0
const sims: number[] = []
const rowsOut: string[] = []

for (const lead of leads) {
  const { rows: cty } = await db.query(`select county_for_zip($1,'NY') c`, [lead.postal_code])
  const county = cty[0]?.c ?? ''

  // Verbatim the guard + query from jobs/registry-match.ts `bestMatch`, so this
  // dry run exercises the production statement rather than a paraphrase of it.
  const GENERIC_FALLBACK = new Set([
    'spa','med','medi','skin','studio','laser','salon','beauty','body','face',
    'glow','care','health','medical','wellness','clinic','center','aesthetic',
    'aesthetics','lounge','day',
  ])
  const match = async () => {
    const toks = distinctiveTokens(lead.business_name, 3).filter(t => !GENERIC_FALLBACK.has(t))
    const params: any[] = ['NY', lead.name_norm, county, 0.6, lead.postal_code]
    let guard: string
    if (toks.length) {
      guard = '(' + toks.map(t => { params.push('%' + t + '%'); return `name_norm like $${params.length}` }).join(' or ') + ')'
    } else {
      params.push(0.9)
      guard = `similarity(name_norm,$2) >= $${params.length}
        and left(regexp_replace(postal_code,'[^0-9]','','g'),5)
          = left(regexp_replace($5,'[^0-9]','','g'),5) and $5 <> ''`
    }
    const { rows } = await db.query(
      `select id, name, county, postal_code, officers,
              similarity(name_norm, $2)::float sim
         from registry_entities
        where state = $1 and ($3 = '' or county = '' or county = $3)
          and name_norm % $2 and similarity(name_norm, $2) >= $4
          and ${guard}
        order by (left(regexp_replace(postal_code,'[^0-9]','','g'),5)
                   = left(regexp_replace($5,'[^0-9]','','g'),5)) desc,
                 (officers <> '[]'::jsonb) desc, similarity(name_norm, $2) desc
        limit 5`, params)
    return rows[0]
  }

  let best = await match()
  if (!best) {
    const t = distinctiveTokens(lead.business_name)
    if (t.length) {
      toppedUp++
      const got = []
      for await (const e of ny.lookup(t, { counties: county ? [county] : COUNTIES, limit: 200 })) got.push(e)
      if (got.length) { await upsertEntities(db, got); best = await match(); if (best) matchedAfterTopUp++ }
    }
  }

  if (best) {
    matched++
    sims.push(best.sim)
    const officer = (best.officers ?? []).find((o: any) => o.kind === 'person' && o.first)
    if (officer) named++
    rowsOut.push(`${lead.business_name.padEnd(38)} | ${county.padEnd(8)} | ${best.sim.toFixed(2)} | ${String(best.name).slice(0,40).padEnd(40)} | ${officer ? officer.first + ' ' + officer.last + ' [' + officer.source_field + ']' : '—'}`)
  } else {
    rowsOut.push(`${lead.business_name.padEnd(38)} | ${county.padEnd(8)} |  —   | ${'(no match)'.padEnd(40)} | —`)
  }
}

console.log('\n' + rowsOut.join('\n'))
sims.sort((a, b) => a - b)
console.log(`\nMATCH: ${matched}/${leads.length} entities matched (${(matched/leads.length*100).toFixed(0)}%)`)
console.log(`       ${toppedUp} needed a top-up lookup, ${matchedAfterTopUp} of those then matched`)
console.log(`NAMED: ${named}/${leads.length} yielded a person-shaped officer (${(named/leads.length*100).toFixed(0)}%)`)
if (sims.length) {
  const q = (p: number) => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))]
  console.log(`SIM:   min ${sims[0].toFixed(2)} p25 ${q(.25).toFixed(2)} median ${q(.5).toFixed(2)} p75 ${q(.75).toFixed(2)} max ${sims[sims.length-1].toFixed(2)}`)
}

await db.end()
