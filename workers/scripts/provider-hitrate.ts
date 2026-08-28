// Measure the provider hit rate on the population it was built for.
//
// HANDOFF §13.3 projects the sendable ceiling off an **assumed** 35% provider
// hit rate and says to measure it on the 176 before committing. This is that
// measurement.
//
// ── Why not just re-run enrich:lead ─────────────────────────────────────────
//
// Re-running the stage costs **5.73 Verifalia checks per lead** re-verifying a
// pattern ladder we already know failed for these leads — 189 × 5.73 ≈ 1,083
// credits against a balance of 883. It would exhaust verification partway and
// leave rows unverified, which is precisely the failure §8.2 says makes a
// niche look undeliverable when it is only unmeasured.
//
// So this asks the two questions directly and pays for nothing else:
//
//   1. Does the provider return an address for this person at this domain?
//      (one provider request, no verification)
//   2. Of the addresses it returns, how many are actually deliverable?
//      (one Verifalia check each — only for hits)
//
// At a 30% hit rate that is 189 provider requests and ~57 verifications rather
// than 1,083.
//
// **Read-only.** It writes no lead, no tier and no contact. The pipeline
// integration in enrich-lead.ts is what changes rows, on future runs.
//
// Usage:
//   npx tsx scripts/provider-hitrate.ts            # lookups only
//   npx tsx scripts/provider-hitrate.ts --verify   # + verify the hits
//   npx tsx scripts/provider-hitrate.ts --limit 40

import { appPool } from './_db.js'
import { makeMailboxProvider } from '../src/sources/mailbox-provider.js'
import { VerifaliaProvider } from '../src/verify/verifalia.js'

const doVerify = process.argv.includes('--verify')
const limitAt = process.argv.indexOf('--limit')
const LIMIT = limitAt > 0 ? Number(process.argv[limitAt + 1]) : 0

const logger = {
  info: () => {}, warn: (m: string, d?: unknown) => console.log('  warn', m, d ?? ''),
  error: (m: string, e?: unknown) => console.log('  error', m, e ?? ''),
  debug: () => {}, child() { return this },
} as never

const db = appPool(2)

interface Row {
  id: string; niche: string; first: string; last: string; domain: string; catch_all: boolean
}

async function main(): Promise<void> {
  // Deliberately not `loadConfig()`. That validates the whole worker
  // environment and refuses to boot without ~15 variables this script never
  // touches; `run.sh` passes only what a script needs. Reading the two keys
  // directly keeps the measurement runnable without pretending to be a worker.
  const provider = makeMailboxProvider({
    mailboxProvider: process.env.MAILBOX_PROVIDER ?? '',
    hunterApiKey: process.env.HUNTER_API_KEY ?? '',
  }, logger)
  if (!provider) throw new Error('no mailbox provider configured — set HUNTER_API_KEY')

  const { rows } = await db.query<Row>(
    `select l.id, lower(c.niche) niche,
            l.owner_first_name first, l.owner_last_name last,
            lower(regexp_replace(regexp_replace(
              split_part(l.website,'?',1), '^https?://',''), '^www\\.','')) domain,
            coalesce(l.domain_catch_all,false) catch_all
       from leads l join campaigns c on c.id = l.campaign_id
      where l.tier = 'C'
        and l.owner_first_name <> '' and l.owner_last_name <> ''
        and coalesce(l.website,'') <> ''
      order by l.id` + (LIMIT ? ` limit ${LIMIT}` : ''))

  console.log(`${rows.length} Tier C leads with a name and a domain\n`)

  const hits: Array<Row & { email: string; score: number | null; sources: number; pstatus: string | null }> = []
  const byNiche = new Map<string, { n: number; hit: number }>()
  let done = 0

  for (const r of rows) {
    const domain = r.domain.replace(/\/.*$/, '')
    const bucket = byNiche.get(r.niche) ?? { n: 0, hit: 0 }
    bucket.n++

    let found = null
    try {
      found = await provider.find(domain, r.first, r.last)
    } catch (err) {
      console.log(`  lookup threw for ${r.first} ${r.last}@${domain}: ${(err as Error).message}`)
    }
    if (found?.email) {
      bucket.hit++
      hits.push({ ...r, email: found.email, score: found.score,
                  sources: found.sources, pstatus: found.providerStatus })
    }
    byNiche.set(r.niche, bucket)

    if (++done % 25 === 0) console.log(`  ${done}/${rows.length} — ${hits.length} hits`)
  }

  const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : '—'

  console.log(`\n── provider: ${provider.name} ──`)
  console.log(`looked up      ${rows.length}`)
  console.log(`returned an address ${hits.length}  (${pct(hits.length, rows.length)})`)
  console.log(`cost           ${(rows.length * provider.centsPerLookup).toFixed(0)}¢\n`)

  console.log('by niche:')
  for (const [niche, b] of [...byNiche].sort((a, c) => c[1].n - a[1].n)) {
    console.log(`  ${niche.padEnd(26)} ${String(b.hit).padStart(3)}/${String(b.n).padEnd(4)} ${pct(b.hit, b.n)}`)
  }

  // `sources: 0` means the provider inferred the address rather than seeing it
  // published. That is the same thing our ladder does, so it is the honest
  // dividing line between "knows" and "guesses better".
  const seen = hits.filter(h => h.sources > 0).length
  console.log(`\nof the hits: ${seen} were seen on a public page (sources > 0), ` +
              `${hits.length - seen} were inferred (sources = 0)`)

  if (!doVerify || !hits.length) {
    console.log('\n(no verification pass — rerun with --verify for the sendable delta)')
    return
  }

  // ── verification ──────────────────────────────────────────────────────────
  // Our verdict, not the provider's. The gate has not moved.
  console.log(`\nverifying ${hits.length} addresses through Verifalia…`)
  const verifalia = new VerifaliaProvider(
    process.env.VERIFALIA_USERNAME ?? '', process.env.VERIFALIA_PASSWORD ?? '',
    logger, 120_000)
  const results = await verifalia.verify(hits.map(h => h.email))
  const byEmail = new Map(results.map(r => [r.email.toLowerCase(), r]))

  let deliverable = 0, catchAll = 0, bad = 0
  const agree = { both: 0, agreed: 0 }
  for (const h of hits) {
    const v = byEmail.get(h.email.toLowerCase())
    if (!v) continue
    if (v.status === 'safe' && !v.is_catch_all) deliverable++
    else if (v.is_catch_all) catchAll++
    else bad++
    if (h.pstatus) {
      agree.both++
      const providerSaysGood = h.pstatus === 'valid'
      const weSayGood = v.status === 'safe' && !v.is_catch_all
      if (providerSaysGood === weSayGood) agree.agreed++
    }
  }

  console.log(`\n── our verdict on the provider's addresses ──`)
  console.log(`deliverable (would be Tier A)  ${deliverable}  (${pct(deliverable, hits.length)} of hits)`)
  console.log(`catch-all   (Tier B at best)   ${catchAll}`)
  console.log(`risky / invalid / unknown      ${bad}`)
  console.log(`\nprovider agreed with us on ${agree.agreed}/${agree.both} ` +
              `(${pct(agree.agreed, agree.both)})`)

  const newSendable = deliverable + catchAll
  console.log(`\n── the number §13.3 wanted ──`)
  console.log(`Tier C leads looked up      ${rows.length}`)
  console.log(`would become sendable       ${newSendable}  (${pct(newSendable, rows.length)})`)
  console.log(`  of which Tier A           ${deliverable}`)
  console.log(`§13.3 assumed 35% — measured ${pct(newSendable, rows.length)}`)
}

main().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
