// Export a campaign as two CSVs: sendable, and the low-volume segment.
//
// The split is the product decision from Phase 4a. Tier A + B is what goes into
// a sequencer; Tier C is named-but-unconfirmed and belongs in a separate,
// smaller, more careful send — never mixed into the main list, because that
// mixing is what produced v1's 6.4% bounce rate.
//
// `tier_reason` is carried through deliberately: the sender needs to segment
// `freemail_business_verified` (a consumer mailbox the business published)
// from `catch_all_named` (right shape, domain accepts everything) because they
// warrant different volume and different copy.
//
// Usage: npx tsx scripts/export-csv.ts <campaignId> [outDir]

import pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 2,
})

const COLUMNS = [
  ['business',        'business_name'],
  ['owner_first',     'owner_first_name'],
  ['owner_last',      'owner_last_name'],
  ['title',           'title'],
  ['name_class',      'name_class'],
  ['email',           'email'],
  ['tier',            'tier'],
  ['tier_reason',     'tier_reason'],
  ['provider_verdict', 'provider_verdict'],
  ['city',            'city'],
  ['phone',           'phone'],
  ['website',         'website'],
  ['sources',         'sources'],
] as const

/**
 * RFC 4180 quoting. Business names in this dataset genuinely contain commas
 * ("Tatiana Masone, NP Aesthetic Injector") and typographic apostrophes, and a
 * naive join would shift every column after them.
 */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  const header = COLUMNS.map(([name]) => name).join(',')
  const body = rows.map(r => COLUMNS.map(([, key]) => csvCell(r[key])).join(','))
  // CRLF and a trailing newline: Excel is the likeliest consumer.
  return [header, ...body].join('\r\n') + '\r\n'
}

const SELECT = `
  select l.business_name,
         l.owner_first_name,
         l.owner_last_name,
         l.title,
         l.name_class,
         coalesce(nullif(l.owner_email,''), c.email, '') email,
         l.tier,
         coalesce(nullif(l.tier_reason,''), l.reject_reason, '') tier_reason,
         -- The verifier's own words, so a human can see WHY it is sendable.
         trim(coalesce(c.provider,'') || ' ' || coalesce(c.status, l.email_status, '')) provider_verdict,
         l.city,
         l.phone,
         l.website,
         array_to_string(l.sources, '|') sources
    from leads l
    left join contacts c
      on c.lead_id = l.id and c.email = nullif(l.owner_email,'')
   where l.campaign_id = $1 and l.tier = any($2)
   order by l.tier, l.business_name`

async function main() {
  const campaignId = process.argv[2]
  if (!campaignId) throw new Error('usage: export-csv.ts <campaignId> [outDir]')
  const outDir = process.argv[3] ?? 'exports'

  const { rows: [c] } = await db.query<{ niche: string; location: string }>(
    `select niche, location from campaigns where id = $1`, [campaignId])
  if (!c) throw new Error(`no campaign ${campaignId}`)

  await mkdir(outDir, { recursive: true })

  const slug = `${c.niche}-${c.location}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  for (const [file, tiers] of [
    ['tier_AB', ['A', 'B']],
    ['tier_C',  ['C']],
  ] as const) {
    const { rows } = await db.query(SELECT, [campaignId, tiers])
    const path = join(outDir, `${slug}-${file}.csv`)
    await writeFile(path, toCsv(rows), 'utf8')
    console.log(`${path.padEnd(52)} ${String(rows.length).padStart(3)} rows`)
  }
}

try { await main() } finally { await db.end() }
