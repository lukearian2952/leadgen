// Phase 1 verifier self-test.
//
// Runs the same 10 addresses through verify-svc and through Verifalia and
// prints a comparison. Five should be deliverable, five should not.
//
// This is a *self-test*, not a unit test: it makes real network calls and
// spends real Verifalia credits (10 of them, ~3 cents), so it lives in
// scripts/ and is run deliberately, never in `npm test`.
//
//   npm run selftest:verify
//   npm run selftest:verify -- --provider=verify-svc   # skip Verifalia
//
// On a host where outbound port 25 is blocked, every verify-svc verdict comes
// back `unknown` with a connect error. That is a hosting problem, not a code
// problem, and the script says so explicitly rather than reporting a failure.

import { networkMode } from '../src/net.js'
import { VerifySvcProvider } from '../src/verify/verifysvc.js'
import { VerifaliaProvider } from '../src/verify/verifalia.js'
import type { VerifierProvider, VerifyResult } from '../src/verify/types.js'
import { Logger } from '../src/logger.js'

// Fixture choice matters more than it looks.
//
// The obvious picks — role addresses at large organisations — are exactly the
// wrong ones. Measured against Verifalia on 2026-08-16: cloudflare.com is
// catch-all, github.com accepts unknown recipients, and microsoft.com rejects
// postmaster/ from outside. On a catch-all domain "deliverable" is unprovable
// by construction, so scoring those as failures cries wolf.
//
// So: the good set is restricted to providers that genuinely reject unknown
// users, plus your own mailbox when VERIFY_FROM_EMAIL is set — that one is the
// only address here we can be certain about.

/**
 * Addresses that should verify as deliverable.
 *
 * Deliberately short. Measured against Verifalia on 2026-08-16, most "obviously
 * real" public role addresses do NOT verify as deliverable: `abuse@gmail.com`
 * and `postmaster@yahoo.com` return invalid, `security@apple.com` returns
 * risky, and cloudflare/github are catch-all. Big providers special-case these
 * mailboxes, so they make terrible fixtures.
 *
 * `postmaster@gmail.com` is the one public address that reliably verifies.
 * For a real positive set, point SELFTEST_GOOD_EMAILS at mailboxes you own —
 * those are the only ones whose expected answer you actually know.
 */
const KNOWN_GOOD = [
  'postmaster@gmail.com',
]

/** Operator-supplied known-deliverable addresses, comma separated. */
function operatorGood(): string[] {
  return (process.env.SELFTEST_GOOD_EMAILS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

/**
 * Addresses that should NOT verify.
 *
 * Random local parts on providers known to reject unknown users, plus two
 * domains that cannot receive mail at all — those must fail at the MX stage,
 * before any SMTP connection, which is also how we confirm the MX short-circuit
 * works.
 */
const KNOWN_BAD = [
  'definitely-not-a-real-mailbox-9f2a@gmail.com',
  'no-such-user-here-7c1d@outlook.com',
  'this-does-not-exist-4b8e@yahoo.com',
  'anyone@example.com',                       // reserved, no MX
  'someone@nonexistent-domain-zz9f2a.invalid', // reserved TLD, cannot resolve
]

/**
 * VERIFY_FROM_EMAIL is included on purpose, and its result is load-bearing.
 *
 * It is the MAIL FROM address verify-svc uses on every probe. Some receiving
 * servers verify the sender before answering RCPT, so if this address is not
 * deliverable the whole verifier degrades — silently, and only against the
 * strictest providers, which are the ones that matter most. Checking it here
 * turns that into a visible line in the self-test.
 */
function ownMailbox(): string[] {
  const own = (process.env.VERIFY_FROM_EMAIL ?? '').trim().toLowerCase()
  return own ? [own] : []
}

interface Row {
  email: string
  expected: 'deliverable' | 'undeliverable'
  svc?: VerifyResult
  verifalia?: VerifyResult
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

/**
 * Score a verdict against expectation.
 *
 * `null` means "no opinion possible", and it is not a failure:
 *   - `unknown`   the provider declined to answer
 *   - catch-all   the domain accepts everything, so neither answer is provable
 * Counting either as wrong is how a self-test starts lying.
 */
function verdictMatches(expected: Row['expected'], result?: VerifyResult): boolean | null {
  if (!result) return null
  if (result.status === 'unknown') return null
  if (result.is_catch_all) return null
  if (expected === 'deliverable') return result.status === 'safe'
  return result.status === 'invalid'
}

function symbol(match: boolean | null): string {
  if (match === null) return '·'
  return match ? '✓' : '✗'
}

async function runProvider(
  provider: VerifierProvider, emails: string[],
): Promise<Map<string, VerifyResult> | string> {
  if (!await provider.available()) {
    return `${provider.name} is not available (missing credentials, or no usable IPs)`
  }
  try {
    const results = await provider.verify(emails)
    return new Map(results.map(r => [r.email, r]))
  } catch (err) {
    return `${provider.name} threw: ${(err as Error).message}`
  }
}

async function main() {
  const only = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1]
  const logger = new Logger((process.env.LOG_LEVEL as 'info') ?? 'warn')

  const good = [...ownMailbox(), ...operatorGood(), ...KNOWN_GOOD]
  const emails = [...good, ...KNOWN_BAD]
  const rows: Row[] = [
    ...good.map(email => ({ email, expected: 'deliverable' as const })),
    ...KNOWN_BAD.map(email => ({ email, expected: 'undeliverable' as const })),
  ]

  console.log(`\nVerifier self-test — ${emails.length} addresses ` +
              `(${good.length} good, ${KNOWN_BAD.length} bad)`)
  console.log(`network: ${networkMode()}\n`)

  // ── verify-svc ─────────────────────────────────────────────────────────────
  let svcNote = ''
  if (only !== 'verifalia') {
    const url = process.env.VERIFY_URL ?? 'http://localhost:8080'
    console.log(`→ verify-svc at ${url}`)
    const outcome = await runProvider(new VerifySvcProvider(url, logger), emails)
    if (typeof outcome === 'string') {
      svcNote = outcome
      console.log(`  skipped: ${outcome}`)
    } else {
      for (const row of rows) row.svc = outcome.get(row.email)
    }
  }

  // ── Verifalia ──────────────────────────────────────────────────────────────
  let verifaliaNote = ''
  if (only !== 'verify-svc') {
    console.log('→ Verifalia')
    const provider = new VerifaliaProvider(
      process.env.VERIFALIA_USERNAME ?? '',
      process.env.VERIFALIA_PASSWORD ?? '',
      logger,
    )
    const outcome = await runProvider(provider, emails)
    if (typeof outcome === 'string') {
      verifaliaNote = outcome
      console.log(`  skipped: ${outcome}`)
    } else {
      for (const row of rows) row.verifalia = outcome.get(row.email)
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('\n' + pad('address', 46) + pad('expected', 15) +
              pad('verify-svc', 22) + 'verifalia')
  console.log('-'.repeat(105))

  let svcCorrect = 0, svcAnswered = 0
  let vfCorrect = 0, vfAnswered = 0
  let agree = 0, bothAnswered = 0

  for (const row of rows) {
    const svcMatch = verdictMatches(row.expected, row.svc)
    const vfMatch = verdictMatches(row.expected, row.verifalia)

    if (svcMatch !== null) { svcAnswered++; if (svcMatch) svcCorrect++ }
    if (vfMatch !== null) { vfAnswered++; if (vfMatch) vfCorrect++ }
    if (row.svc && row.verifalia &&
        row.svc.status !== 'unknown' && row.verifalia.status !== 'unknown') {
      bothAnswered++
      if (row.svc.status === row.verifalia.status) agree++
    }

    const svcCell = row.svc
      ? `${symbol(svcMatch)} ${row.svc.status}${row.svc.is_catch_all ? ' (catch-all)' : ''}`
      : '—'
    const vfCell = row.verifalia
      ? `${symbol(vfMatch)} ${row.verifalia.status}${row.verifalia.is_catch_all ? ' (catch-all)' : ''}`
      : '—'

    console.log(pad(row.email, 46) + pad(row.expected, 15) + pad(svcCell, 22) + vfCell)
  }

  console.log('-'.repeat(105))

  // "answered" is the plumbing check: did the provider return a verdict at all.
  // "scored" excludes catch-all domains, where no verdict is provable.
  const svcVerdicts = rows.filter(r => r.svc && r.svc.status !== 'unknown').length
  const vfVerdicts = rows.filter(r => r.verifalia && r.verifalia.status !== 'unknown').length
  const svcRan = rows.filter(r => r.svc).length
  const vfRan = rows.filter(r => r.verifalia).length

  console.log(`verify-svc : ${svcCorrect}/${svcAnswered} scored correct · ` +
              `${svcVerdicts}/${svcRan} answered · ` +
              `${svcRan - svcAnswered} unscoreable (unknown or catch-all)`)
  console.log(`verifalia  : ${vfCorrect}/${vfAnswered} scored correct · ` +
              `${vfVerdicts}/${vfRan} answered · ` +
              `${vfRan - vfAnswered} unscoreable (unknown or catch-all)`)
  if (bothAnswered) {
    console.log(`agreement  : ${agree}/${bothAnswered} ` +
                `(${Math.round((agree / bothAnswered) * 100)}%)`)
  }

  // ── Diagnose the most likely infrastructure failure ────────────────────────
  const svcResults = rows.map(r => r.svc).filter(Boolean) as VerifyResult[]
  const allUnknown = svcResults.length > 0 && svcResults.every(r => r.status === 'unknown')
  const connectFailures = svcResults.filter(r =>
    /connect failed|dial|timeout|refused|unreachable|network/i.test(r.detail ?? '')).length

  if (allUnknown && connectFailures > 0) {
    console.log(
      '\n⚠  PORT 25 BLOCKED — every verify-svc probe failed to connect.\n' +
      '   This is a hosting restriction, not a defect. Hostinger blocks outbound\n' +
      '   port 25 by default on VPS plans and unblocks it on request.\n' +
      '   Until it is open, run VERIFIER=verifalia.',
    )
    process.exit(0)
  }

  const from = (process.env.VERIFY_FROM_EMAIL ?? '').trim().toLowerCase()
  const fromRow = rows.find(r => r.email === from)
  const fromVerdict = fromRow?.verifalia ?? fromRow?.svc
  if (from && fromVerdict && fromVerdict.status === 'invalid') {
    console.log(
      `\n⚠  VERIFY_FROM_EMAIL (${from}) is NOT deliverable.\n` +
      '   It is the MAIL FROM on every SMTP probe. Receivers that verify the\n' +
      '   sender before answering RCPT will refuse us — and those are the strict\n' +
      '   providers whose verdicts matter most. Create this mailbox before\n' +
      '   relying on verify-svc.')
  }

  if (svcNote) console.log(`\nnote: ${svcNote}`)
  if (verifaliaNote) console.log(`note: ${verifaliaNote}`)

  const anyAnswered = svcAnswered + vfAnswered > 0
  if (!anyAnswered) {
    console.log('\n✗ No provider produced a single verdict.')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('self-test crashed:', err)
  process.exit(1)
})
