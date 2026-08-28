// Rebuild the exports directory: two spreadsheets per niche, deduped by business.
//
// ── The split ───────────────────────────────────────────────────────────────
//
//   <niche>-sendable.csv   Tier A + Tier B, MailForge-shaped columns.
//   <niche>-raw.csv        every other business we touched.
//
// Tier A and B share a file because both are sendable; `tier` and `tier_reason`
// ride at the end so they can be segmented apart. **They should be.** Tier A is
// a verified mailbox. Tier B is a named owner on a catch-all domain, or an
// owner-named freemail address — right shape, no proof the mailbox exists.
// Mixing them at equal volume is what produced v1's 6.4% bounce rate.
//
// The raw file is deliberately everything else, including businesses that never
// reached a tier at all: 40 med spa leads were discovered and never enriched.
// They are not failures of deliverability, they are work that stopped, and
// hiding them would misrepresent what was scraped.
//
// ── Dedupe ──────────────────────────────────────────────────────────────────
//
// `business_id`, else `place_id`, else the normalised website, else the row id.
// This is the key the published figures were computed with, and it reproduces
// them exactly: 1,395 tiered businesses, 242 sendable.
//
// Two orderings were tried and rejected on measurement. Keying on the website
// first breaks car wrap, where 95 rows have no website at all and each became
// its own "business" (921 → 1,034). Keying on `place_id` first breaks it the
// other way — every car wrap row has a distinct place, so nothing deduped
// (1,042), while SaaS collapsed to a single row because its `place_id` is `''`
// rather than null.
//
// The website is normalised — scheme, `www.`, query and trailing slash removed
// — but the **path is kept**, because Restore Hyper Wellness is seven real
// locations under `restore.com/locations/…` and stripping to the bare domain
// would silently drop six businesses.
//
// **A known limit, disclosed rather than fixed.** Med spa carries
// `business_id` on only 225 of 375 rows, so a business whose rows are split
// between a set id and a null one can appear twice — Perfect Med Spa is the
// worked example. It affects the raw file, where near-duplicates are noise
// rather than harm, and the file is explicitly the everything pile. The
// sendable file is additionally deduped on the email address itself, below,
// because that is where a duplicate actually costs something.
//
// The same business discovered under two niches appears in both niches' files,
// which is correct for a per-niche deliverable and means the per-niche totals
// sum higher than the global unique count. The summary prints both so the
// difference is visible rather than a discrepancy someone finds later.
//
// Where several rows describe one business, the most complete wins: a tier
// first, then a deliverable mailbox, then an owner name.
//
// Usage: npx tsx scripts/export-niches.ts [outDir]

import pg from 'pg'
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const OUT = process.argv[2] ?? 'exports'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

/** DB niche (lowercased) → file slug. */
const NICHES: Array<[string, string]> = [
  ['car wrap',                 'car-wrap'],
  ['vehicle wrap shop',        'vehicle-wrap-shop'],
  ['med spa',                  'med-spa'],
  ['dental practice',          'dental-practice'],
  ['practice management saas', 'practice-mgmt-saas'],
]

const SENDABLE_COLS = [
  'first_name', 'last_name', 'company_name', 'email', 'phone', 'website', 'city',
  'tier', 'tier_reason',
]

/**
 * Page CTAs `saas:discover` mistook for company names. Anchored, so a real
 * company called "Demo Systems" is untouched.
 */
const JUNK_NAME_RE =
  '^(request|book|get|schedule|start|try)\\s+(a\\s+)?(demo|trial|quote|free)' +
  '|^(pricing|contact us|practice management software|home|about us|login|sign in)'

/**
 * Normalise a website into a business key: strip scheme, `www.`, query and
 * trailing slash — but **keep the path**, which is what separates the seven
 * Restore Hyper Wellness franchise locations from one another.
 *
 * Inlined rather than created as a database function: this is an export script
 * and it should not leave objects behind in a schema it does not own.
 */
const NORM_SITE = (col: string) => `nullif(regexp_replace(regexp_replace(regexp_replace(
  lower(coalesce(${col},'')), '^https?://(www\\.)?', ''), '[?#].*$', ''), '/+$', ''), '')`

const RAW_COLS = [
  'company_name', 'scraped_name', 'phone', 'website', 'city', 'state',
  'owner_first_name', 'owner_last_name', 'title',
  'email', 'best_general_email', 'tier', 'reject_reason', 'sources',
]

interface Row {
  niche: string
  business_key: string
  business_name: string | null
  scraped_name: string | null
  phone: string | null
  website: string | null
  city: string | null
  state: string | null
  owner_first_name: string | null
  owner_last_name: string | null
  title: string | null
  owner_email: string | null
  general_email: string | null
  tier: string | null
  tier_reason: string | null
  reject_reason: string | null
  sources: string | null
}

/** RFC 4180: quote when the value could otherwise break the row. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csv(cols: string[], rows: Array<Record<string, unknown>>): string {
  const out = [cols.join(',')]
  for (const r of rows) out.push(cols.map(c => csvCell(r[c])).join(','))
  // Trailing newline: without it the last record is ambiguous to some parsers.
  return out.join('\n') + '\n'
}

async function main(): Promise<void> {
  // ── one row per business per niche ────────────────────────────────────────
  const { rows } = await db.query<Row>(`
    select distinct on (niche, business_key)
      lower(c.niche) niche,
      coalesce(l.business_id::text, nullif(l.place_id,''), ${NORM_SITE('l.website')}, l.id::text) business_key,
      -- saas:discover scraped a page CTA instead of a company name on 44 rows:
      -- Request a Demo, Book a demo, Practice Management Software Pricing.
      -- Merged into an email that reads "I saw Request a Demo...", so the domain
      -- stands in - factual, and the only company identifier those rows have.
      -- The scraped value is kept in scraped_name on the raw file.
      case when l.business_name ~* $2 then ${NORM_SITE('l.website')}
           else nullif(l.business_name,'') end business_name,
      nullif(l.business_name,'')     scraped_name,
      nullif(l.phone,'')             phone,
      nullif(l.website,'')           website,
      nullif(l.city,'')              city,
      nullif(l.state,'')             state,
      nullif(l.owner_first_name,'')  owner_first_name,
      nullif(l.owner_last_name,'')   owner_last_name,
      nullif(l.title,'')             title,
      nullif(l.owner_email,'')       owner_email,
      nullif(l.email,'')             general_email,
      nullif(l.tier,'')              tier,
      nullif(l.tier_reason,'')       tier_reason,
      nullif(l.reject_reason,'')     reject_reason,
      array_to_string(l.sources,'|') sources
    from leads l
    join campaigns c on c.id = l.campaign_id
    where lower(c.niche) = any($1::text[])
    order by
      niche, business_key,
      -- Most complete row wins where a business appears more than once.
      case l.tier when 'A' then 4 when 'B' then 3 when 'C' then 2
                  when 'rejected' then 1 else 0 end desc,
      (nullif(l.owner_email,'') is not null) desc,
      (nullif(l.owner_first_name,'') is not null) desc,
      l.created_at desc
  `, [NICHES.map(n => n[0]), JUNK_NAME_RE])

  await mkdir(OUT, { recursive: true })

  // ── clear the directory ──────────────────────────────────────────────────
  // Everything here is stale and regenerated below. Lock files from an editor
  // are removed too, or a reopened spreadsheet silently reads the old data.
  const existing = await readdir(OUT).catch(() => [] as string[])
  for (const f of existing) await unlink(join(OUT, f)).catch(() => {})
  if (existing.length) console.log(`cleared ${existing.length} stale file(s) from ${OUT}/\n`)

  const summary: Array<{ niche: string; sendable: number; raw: number; total: number }> = []
  const files: string[] = []

  for (const [niche, slug] of NICHES) {
    const mine = rows.filter(r => r.niche === niche)
    const sendable = mine.filter(r => r.tier === 'A' || r.tier === 'B')
    const raw = mine.filter(r => !(r.tier === 'A' || r.tier === 'B'))

    // One row per mailbox. Two rows for one business that survived the key above
    // would otherwise be two sends to the same person — the only duplicate that
    // costs anything. Tier A wins over B because `sendable` is already ordered
    // by tier.
    const seenEmail = new Set<string>()
    const sendableRows = sendable
      .filter(r => {
        const e = (r.owner_email ?? '').trim().toLowerCase()
        if (!e || seenEmail.has(e)) return false
        seenEmail.add(e)
        return true
      })
      .map(r => ({
      first_name:   r.owner_first_name ?? '',
      last_name:    r.owner_last_name ?? '',
      company_name: r.business_name ?? '',
      email:        r.owner_email ?? '',
      phone:        r.phone ?? '',
      website:      r.website ?? '',
      city:         r.city ?? '',
      tier:         r.tier ?? '',
      tier_reason:  r.tier_reason ?? '',
    }))

    const rawRows = raw.map(r => ({
      company_name:       r.business_name ?? '',
      // Only when it differs — otherwise every row carries it twice.
      scraped_name:       r.scraped_name && r.scraped_name !== r.business_name
                            ? r.scraped_name : '',
      phone:              r.phone ?? '',
      website:            r.website ?? '',
      city:               r.city ?? '',
      state:              r.state ?? '',
      owner_first_name:   r.owner_first_name ?? '',
      owner_last_name:    r.owner_last_name ?? '',
      title:              r.title ?? '',
      email:              r.owner_email ?? '',
      best_general_email: r.general_email ?? '',
      // Blank rather than 'null' for a business that never reached a tier.
      tier:               r.tier ?? '',
      reject_reason:      r.reject_reason ?? '',
      sources:            r.sources ?? '',
    }))

    const sFile = `${slug}-sendable.csv`
    const rFile = `${slug}-raw.csv`
    await writeFile(join(OUT, sFile), csv(SENDABLE_COLS, sendableRows))
    await writeFile(join(OUT, rFile), csv(RAW_COLS, rawRows))
    files.push(sFile, rFile)

    summary.push({ niche, sendable: sendableRows.length, raw: rawRows.length, total: mine.length })
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => s.padEnd(n)
  const num = (n: number, w = 8) => String(n).padStart(w)

  console.log(`${pad('niche', 26)}${'sendable'.padStart(9)}${'raw'.padStart(8)}${'total'.padStart(8)}`)
  console.log('─'.repeat(51))
  let ts = 0, tr = 0, tt = 0
  for (const s of summary) {
    console.log(`${pad(s.niche, 26)}${num(s.sendable, 9)}${num(s.raw)}${num(s.total)}`)
    ts += s.sendable; tr += s.raw; tt += s.total
  }
  console.log('─'.repeat(51))
  console.log(`${pad('total (per-niche)', 26)}${num(ts, 9)}${num(tr)}${num(tt)}`)

  // ── reconciliation ───────────────────────────────────────────────────────
  const { rows: [g] } = await db.query<{ businesses: string; sendable: string; tiered: string }>(`
    with r as (
      select coalesce(l.business_id::text, l.place_id, lower(nullif(l.website,'')), l.id::text) k,
             max(case l.tier when 'A' then 4 when 'B' then 3 when 'C' then 2
                             when 'rejected' then 1 else 0 end) t
        from leads l join campaigns c on c.id = l.campaign_id
       where lower(c.niche) = any($1::text[]) group by 1)
    select count(*) businesses,
           count(*) filter (where t >= 3) sendable,
           count(*) filter (where t >= 1) tiered
      from r`, [NICHES.map(n => n[0])])

  console.log(`\nglobally unique businesses (dedup across niches): ${g.businesses}`)
  console.log(`  of which sendable:                              ${g.sendable}`)
  console.log(`  of which carry a tier:                          ${g.tiered}`)
  console.log(`per-niche rows sum higher by ${tt - Number(g.businesses)} — businesses discovered under two niches`)
  console.log(`\nfiles written to ${OUT}/`)
}

main().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
