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

import { VerifySvcProvider } from '../src/verify/verifysvc.js'
import { VerifaliaProvider } from '../src/verify/verifalia.js'
import type { VerifierProvider, VerifyResult } from '../src/verify/types.js'
import { Logger } from '../src/logger.js'

/**
 * Addresses that should verify as deliverable.
 *
 * These are published role addresses at large, stable organisations — chosen
 * because they will still exist next year and because probing them is
 * unremarkable traffic. Do not put a customer's address in here.
 */
const KNOWN_GOOD = [
  'postmaster@gmail.com',
  'abuse@cloudflare.com',
  'security@github.com',
  'postmaster@microsoft.com',
  'hostmaster@ietf.org',
]

/**
 * Addresses that should NOT verify.
 *
 * The first four are random local parts on real, non-catch-all domains; the
 * last is a domain with no MX at all, which should fail before any SMTP.
 */
const KNOWN_BAD = [
  'definitely-not-a-real-mailbox-9f2a@gmail.com',
  'no-such-user-here-7c1d@github.com',
  'this-does-not-exist-4b8e@ietf.org',
  'nonexistent-mailbox-2a6f@cloudflare.com',
  'anyone@example.com',
]

interface Row {
  email: string
  expected: 'deliverable' | 'undeliverable'
  svc?: VerifyResult
  verifalia?: VerifyResult
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

/** A result matches expectation if safe↔deliverable, invalid↔undeliverable. */
function verdictMatches(expected: Row['expected'], result?: VerifyResult): boolean | null {
  if (!result) return null
  if (result.status === 'unknown') return null      // no opinion, not a failure
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

  const emails = [...KNOWN_GOOD, ...KNOWN_BAD]
  const rows: Row[] = [
    ...KNOWN_GOOD.map(email => ({ email, expected: 'deliverable' as const })),
    ...KNOWN_BAD.map(email => ({ email, expected: 'undeliverable' as const })),
  ]

  console.log(`\nVerifier self-test — ${emails.length} addresses ` +
              `(${KNOWN_GOOD.length} good, ${KNOWN_BAD.length} bad)\n`)

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
  console.log(`verify-svc : ${svcCorrect}/${svcAnswered} correct ` +
              `(${rows.length - svcAnswered} unknown)`)
  console.log(`verifalia  : ${vfCorrect}/${vfAnswered} correct ` +
              `(${rows.length - vfAnswered} unknown)`)
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
