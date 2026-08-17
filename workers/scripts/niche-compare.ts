// Side-by-side niche comparison: is the constraint the pipeline or the niche?
//
// The hypothesis from Phase 4a is that med spas are close to the worst case for
// owner mailboxes — they run on booking platforms and consumer mail, and the
// crawl census found exactly ONE personal address on a business's own domain
// across 75 businesses. If that single number predicts Tier A, then a niche
// with real own-domain mail should convert and the pipeline is fine.
//
// Usage: npx tsx scripts/niche-compare.ts <campaignId> [<campaignId> ...]

import pg from 'pg'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const ids = process.argv.slice(2)
if (!ids.length) throw new Error('usage: niche-compare.ts <campaignId> [...]')

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : '—'

interface Row { label: string; values: string[] }

const campaigns: Array<{ id: string; niche: string; location: string }> = []
for (const id of ids) {
  const [c] = await q(`select id, niche, location from campaigns where id = $1`, [id])
  if (!c) throw new Error(`no campaign ${id}`)
  campaigns.push(c as { id: string; niche: string; location: string })
}

const rows: Row[] = []
const add = (label: string, values: string[]) => rows.push({ label, values })

const per = async <T>(fn: (id: string) => Promise<T>): Promise<T[]> =>
  Promise.all(campaigns.map(c => fn(c.id)))

// ── funnel ───────────────────────────────────────────────────────────────────
const funnels = await per(async id => {
  const [f] = await q(`
    select count(*)::int total,
           count(*) filter (where crawl_done)::int crawled,
           count(*) filter (where website <> '')::int with_site,
           count(*) filter (where owner_first_name <> '')::int named,
           count(*) filter (where tier='A')::int a,
           count(*) filter (where tier='B')::int b,
           count(*) filter (where tier='C')::int c,
           count(*) filter (where tier='rejected')::int rejected
      from leads where campaign_id = $1`, [id])
  return f as Record<string, number>
})

add('businesses kept', funnels.map(f => String(f.total)))
add('with a website', funnels.map(f => `${f.with_site} (${pct(f.with_site, f.total)})`))
add('NAMED', funnels.map(f => `${f.named} (${pct(f.named, f.total)})`))
add('Tier A', funnels.map(f => String(f.a)))
add('Tier B', funnels.map(f => String(f.b)))
add('Tier C', funnels.map(f => String(f.c)))
add('rejected', funnels.map(f => String(f.rejected)))
add('Tier A+B (sendable)', funnels.map(f => `${f.a + f.b} (${pct(f.a + f.b, f.total)})`))

// ── named-rate per source ────────────────────────────────────────────────────
for (const source of ['site_crawl', 'registry', 'serp'] as const) {
  const vals = await per(async id => {
    const [r] = await q(`
      with cand as (
        select l.id, jsonb_array_elements(coalesce(l.evidence->'name_candidates','[]'::jsonb)) c
          from leads l where l.campaign_id = $1)
      select count(distinct id) filter (where c->>'source' = $2
                                          and c->>'nameClass' = 'owner_grade')::int n
        from cand where coalesce(c->>'first','') <> ''`, [id, source])
    return Number((r as { n: number }).n)
  })
  add(`  named by ${source}`, vals.map((v, i) => `${v} (${pct(v, funnels[i].total)})`))
}

// ── the predictor: on-domain personal addresses ──────────────────────────────
//
// This is the number Phase 4a nominated as predicting Tier A. Counted the same
// way for every niche: addresses the crawl saw that are on the business's own
// domain and are not a role inbox.
const ROLE = "^(info|hello|contact|admin|office|support|sales|booking|bookings|appointments"
           + "|reception|team|care|help|mail|email|billing|frontdesk|front-desk|schedule"
           + "|scheduling|spa|clinic|orders|general|newpatients|patients|clients|inquiries"
           + "|enquiries|noreply|no-reply|concierge|service|services|smile|dental|office2)"

const census = await per(async id => {
  const [r] = await q(`
    with e as (
      select l.id,
             split_part(regexp_replace(regexp_replace(l.website,'^https?://',''),'^www\\.',''),'/',1) dom,
             lower(jsonb_array_elements_text(coalesce(l.evidence->'crawl_emails','[]'::jsonb))) em
        from leads l where l.campaign_id = $1 and l.website <> '')
    select count(*)::int total_addresses,
           count(*) filter (where split_part(em,'@',2) = dom)::int on_domain,
           count(*) filter (where split_part(em,'@',2) = dom
                              and split_part(em,'@',1) !~ $2)::int on_domain_personal,
           count(distinct id) filter (where split_part(em,'@',2) = dom
                              and split_part(em,'@',1) !~ $2)::int businesses_with_one
      from e`, [id, ROLE])
  return r as Record<string, number>
})

add('addresses seen by crawl', census.map(c => String(c.total_addresses)))
add('  on own domain', census.map(c => String(c.on_domain)))
add('  ON-DOMAIN PERSONAL', census.map(c => String(c.on_domain_personal)))
add('  businesses with ≥1', census.map((c, i) =>
  `${c.businesses_with_one} (${pct(c.businesses_with_one, funnels[i].total)})`))

// ── reverse lookup ───────────────────────────────────────────────────────────
const reverse = await per(async id => {
  const [r] = await q(`
    select coalesce(sum((detail->>'reverse_checked')::int),0)::int checked,
           coalesce(sum((detail->>'reverse_hits')::int),0)::int hits,
           coalesce(sum((detail->>'reverse_county_hits')::int),0)::int county_hits,
           coalesce(sum((detail->>'reverse_statewide_hits')::int),0)::int statewide_hits,
           coalesce(sum((detail->>'reverse_statewide_queries')::int),0)::int statewide_queries,
           coalesce(sum((detail->>'reverse_statewide_ambiguous')::int),0)::int statewide_ambiguous
      from job_runs
     where campaign_id = $1 and stage = 'registry:match' and status = 'success'`, [id])
  return r as Record<string, number>
})

add('reverse: people checked', reverse.map(r => String(r.checked)))
add('reverse: hits', reverse.map(r => `${r.hits} (${pct(r.hits, r.checked)})`))
add('  of which county', reverse.map(r => String(r.county_hits)))
add('  of which statewide', reverse.map(r => String(r.statewide_hits)))
add('  statewide queries', reverse.map(r => String(r.statewide_queries)))
add('  statewide rejected (common name)', reverse.map(r => String(r.statewide_ambiguous)))

// ── cost ─────────────────────────────────────────────────────────────────────
const costs = await per(async id => {
  const [r] = await q(`
    select coalesce(sum(cost_cents),0)::numeric cents,
           coalesce(sum(cost_cents) filter (where stage='enrich:lead'),0)::numeric verify_cents,
           count(*) filter (where status='failed')::int failed
      from job_runs where campaign_id = $1`, [id])
  return r as Record<string, number>
})

add('total cost', costs.map(c => `${Number(c.cents).toFixed(1)}¢`))
add('  of which Verifalia', costs.map(c => `${Number(c.verify_cents).toFixed(1)}¢`))
add('COST PER BUSINESS', costs.map((c, i) =>
  funnels[i].total ? `$${(Number(c.cents) / 100 / funnels[i].total).toFixed(4)}` : '—'))
add('failed jobs', costs.map(c => String(c.failed)))

// ── render ───────────────────────────────────────────────────────────────────
const headers = campaigns.map(c => `${c.niche} / ${c.location}`)
const labelW = Math.max(...rows.map(r => r.label.length), 'metric'.length)
const colW = headers.map((h, i) =>
  Math.max(h.length, ...rows.map(r => (r.values[i] ?? '').length)))

console.log('\n' + 'metric'.padEnd(labelW) + ' │ ' + headers.map((h, i) => h.padEnd(colW[i])).join(' │ '))
console.log('─'.repeat(labelW) + '─┼─' + colW.map(w => '─'.repeat(w)).join('─┼─'))
for (const r of rows) {
  console.log(r.label.padEnd(labelW) + ' │ ' +
    r.values.map((v, i) => (v ?? '').padEnd(colW[i])).join(' │ '))
}
console.log()

await db.end()
