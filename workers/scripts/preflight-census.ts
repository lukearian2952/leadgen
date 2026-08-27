// Run the preflight census for real, and check the predictor against outcomes.
//
// ── What was actually missing ────────────────────────────────────────────────
//
// `lib/preflight.ts` is a pure library with 13 passing tests, `preflight_runs`
// is a table, and the UI has two panels that read it. **Nothing ever ran it.**
// There is no `preflight:*` job and never was: the feature was a predictor with
// no path from a niche to a number, which is why `preflight_runs` was empty and
// why both UI panels have only ever rendered their no-census fallback.
//
// ── Why the census is computed from finished campaigns ───────────────────────
//
// A pre-campaign preflight would discover 25 businesses, crawl them, and count.
// That path costs money and — more importantly for a *calibration* — produces a
// 25-business sample when we already hold 75-, 79-, 100-, 149- and
// 1,042-business populations that were crawled by the same crawler.
//
// So this computes the census over completed campaigns. It is the better
// calibration input: bigger n, and the Tier A outcome it is being checked
// against is measured on the same rows rather than on a different sample.
//
// **What it therefore does not test** is the sampling path — whether 25
// businesses predict 1,000. That is a separate question and this does not
// answer it. Stated here rather than left for someone to assume.
//
// ── Where the numbers come from ──────────────────────────────────────────────
//
//   businessesFound        leads in the campaign
//   businessesWithSite     leads with a usable domain
//   addressesSeen          contacts found by the crawl (`sources @> site_crawl`)
//   onDomainAddresses      …whose mailbox domain is the business's own domain
//   onDomainPersonal       the same rows: crawl-site only ever inserts a
//                          *personal-looking* address, never a role inbox
//   businessesWithPersonal distinct businesses with at least one of those
//
// `censusRate` is `businessesWithPersonal / businessesFound` — the share of
// businesses that publish a personal address on their own domain. Not
// addresses-over-addresses, which is a different and much larger number.
//
// Usage:
//   npx tsx scripts/preflight-census.ts            # report only
//   npx tsx scripts/preflight-census.ts --apply    # also write preflight_runs

import { appPool } from './_db.js'
import { predictTierA, censusRate, estimateCost, type CensusResult } from '../src/lib/preflight.js'

const APPLY = process.argv.includes('--apply')
const db = appPool(2)

/** The four the calibration was asked for, plus the third seed point. */
const TARGETS = [
  { id: '0419ce66-259c-4dd0-9023-070cabb09a6b', niche: 'med spa',                  location: 'Long Island, NY' },
  { id: '53a6ea20-f3f7-4f91-b5ce-d4ebd250c882', niche: 'dental practice',          location: 'Long Island, NY' },
  { id: '1c7f3e2f-0ef7-44aa-828a-9fa9e4dee2df', niche: 'vehicle wrap shop',        location: 'New York' },
  { id: '67aaaad4-c23a-44fc-9e94-e059e7470e00', niche: 'car wrap',                 location: 'United States' },
  { id: '0880d44f-400c-4132-91ac-9c142a448390', niche: 'practice management SaaS', location: 'United States' },
]

interface Outcome {
  leads: number
  withSite: number
  addresses: number
  onDomain: number
  businessesWithPersonal: number
  named: number
  tierA: number
  tierB: number
}

const rows: Array<{ t: typeof TARGETS[number]; c: CensusResult; o: Outcome }> = []

for (const t of TARGETS) {
  const { rows: [o] } = await db.query<Record<string, string>>(
    `select
       (select count(*) from leads where campaign_id = $1) leads,
       (select count(*) from leads l join businesses b on b.id = l.business_id
         where l.campaign_id = $1 and coalesce(b.domain,'') <> '') with_site,
       (select count(*) from contacts
         where campaign_id = $1 and sources @> array['site_crawl']) addresses,
       (select count(*) from contacts ct
          join leads l on l.id = ct.lead_id
          join businesses b on b.id = l.business_id
         where ct.campaign_id = $1 and ct.sources @> array['site_crawl']
           and lower(split_part(ct.email,'@',2)) = lower(b.domain)) on_domain,
       (select count(distinct ct.lead_id) from contacts ct
          join leads l on l.id = ct.lead_id
          join businesses b on b.id = l.business_id
         where ct.campaign_id = $1 and ct.sources @> array['site_crawl']
           and lower(split_part(ct.email,'@',2)) = lower(b.domain)) biz_with_personal,
       (select count(*) from leads
         where campaign_id = $1 and coalesce(owner_first_name,'') <> '') named,
       (select count(*) from leads where campaign_id = $1 and tier = 'A') tier_a,
       (select count(*) from leads where campaign_id = $1 and tier = 'B') tier_b`,
    [t.id])

  const census: CensusResult = {
    businessesFound:        Number(o.leads),
    businessesWithSite:     Number(o.with_site),
    addressesSeen:          Number(o.addresses),
    onDomainAddresses:      Number(o.on_domain),
    // crawl-site only inserts a personal-looking address, never a role inbox,
    // so an on-domain crawled contact *is* an on-domain personal address.
    onDomainPersonal:       Number(o.on_domain),
    businessesWithPersonal: Number(o.biz_with_personal),
    named:                  Number(o.named),
  }

  rows.push({
    t, c: census,
    o: {
      leads: Number(o.leads), withSite: Number(o.with_site),
      addresses: Number(o.addresses), onDomain: Number(o.on_domain),
      businessesWithPersonal: Number(o.biz_with_personal),
      named: Number(o.named), tierA: Number(o.tier_a), tierB: Number(o.tier_b),
    },
  })
}

// ── report ───────────────────────────────────────────────────────────────────

const line = '─'.repeat(96)
console.log('\nniche / location                  n     census%  predicted    band       actual A  in band?')
console.log(line)

let inBand = 0
for (const { t, c, o } of rows) {
  const rate = censusRate(c)
  const p = predictTierA(rate)
  const actualA = o.leads ? (o.tierA / o.leads) * 100 : 0
  const hit = actualA >= p.low && actualA <= p.high
  if (hit) inBand++

  console.log(
    `${(t.niche + ' / ' + t.location).slice(0, 32).padEnd(33)} ` +
    `${String(o.leads).padEnd(5)} ` +
    `${rate.toFixed(1).padStart(6)}%  ` +
    `${(p.low + '–' + p.high + '%').padEnd(11)} ` +
    `${p.band.padEnd(10)} ` +
    `${actualA.toFixed(1).padStart(7)}%  ` +
    `${hit ? 'YES' : 'NO'}`)
}
console.log(line)
console.log(`\npredictor inside its own band: ${inBand}/${rows.length}`)

console.log('\ndetail')
for (const { t, c, o } of rows) {
  const rate = censusRate(c)
  const actualAB = o.leads ? ((o.tierA + o.tierB) / o.leads) * 100 : 0
  console.log(`\n  ${t.niche} / ${t.location}`)
  console.log(`    businesses            ${o.leads}  (${o.withSite} with a site)`)
  console.log(`    personal addresses    ${o.addresses} crawled, ${o.onDomain} on the business's own domain`)
  console.log(`    businesses with one   ${o.businessesWithPersonal}  → census ${rate.toFixed(2)}%`)
  console.log(`    named                 ${o.named} (${((o.named / o.leads) * 100).toFixed(1)}%)`)
  console.log(`    Tier A / A+B          ${o.tierA} (${((o.tierA / o.leads) * 100).toFixed(1)}%) / ${o.tierA + o.tierB} (${actualAB.toFixed(1)}%)`)
  console.log(`    predicted             ${predictTierA(rate).summary}`)
}

// ── persist ──────────────────────────────────────────────────────────────────

if (APPLY) {
  const { rows: [owner] } = await db.query<{ user_id: string }>(
    `select user_id from campaigns order by created_at desc limit 1`)

  for (const { t, c, o } of rows) {
    const rate = censusRate(c)
    const p = predictTierA(rate)
    const cost = estimateCost(o.leads)
    await db.query(
      `insert into preflight_runs
         (user_id, niche, location, sample_size, status,
          businesses_found, businesses_with_site, addresses_seen,
          on_domain_addresses, on_domain_personal, businesses_with_personal,
          named, predicted_tier_a_low, predicted_tier_a_high, predicted_band,
          estimated_cost_usd, finished_at)
       -- 'complete', not 'ok'. The column has a check constraint allowing
       -- running | complete | failed, and both this script and the two UI
       -- panels were originally written against an imagined 'ok'.
       values ($1,$2,$3,$4,'complete',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
      [owner.user_id, t.niche, t.location, c.businessesFound,
       c.businessesFound, c.businessesWithSite, c.addressesSeen,
       c.onDomainAddresses, c.onDomainPersonal, c.businessesWithPersonal,
       c.named, p.low, p.high, p.band, cost.high])
    console.log(`  wrote preflight_runs: ${t.niche} / ${t.location}`)
  }
}

await db.end()
