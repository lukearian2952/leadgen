import { describe, it, expect, vi } from 'vitest'
import { HybridVerifier, MemoryBudgetLedger, agreementRate } from '../src/verify/hybrid.js'
import { VERIFALIA_COST_CENTS } from '../src/verify/verifalia.js'
import type { VerifierProvider, VerifyResult, VerifyStatus } from '../src/verify/types.js'
import { Logger } from '../src/logger.js'

const silent = new Logger('error')

function result(email: string, status: VerifyStatus, provider: string, extra: Partial<VerifyResult> = {}): VerifyResult {
  return {
    email, status, provider,
    is_catch_all: false, is_disposable: false, is_role: false,
    latency_ms: 1, cost_cents: provider === 'verifalia' ? VERIFALIA_COST_CENTS : 0,
    ...extra,
  }
}

function stubProvider(
  name: string, verdicts: Record<string, VerifyStatus>, available = true,
): VerifierProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name,
    calls,
    async available() { return available },
    async verify(emails: string[]) {
      calls.push([...emails])
      return emails.map(e => result(e, verdicts[e] ?? 'unknown', name))
    },
  }
}

describe('hybrid routing', () => {
  // Rule 3: a decided verdict is final. This is the rule that keeps the paid
  // provider cheap — v1 verified every pattern guess through Verifalia.
  it('never escalates safe or invalid, even for a high-trust name', async () => {
    const primary = stubProvider('verify-svc', {
      'a@x.com': 'safe',
      'b@x.com': 'invalid',
    })
    const fallback = stubProvider('verifalia', {})

    const hybrid = new HybridVerifier(primary, fallback, new MemoryBudgetLedger(), 500, silent)
    const outcome = await hybrid.verify('c1', [
      { email: 'a@x.com', highTrustName: true },
      { email: 'b@x.com', highTrustName: true },
    ])

    expect(fallback.calls).toEqual([])
    expect(outcome.stats.verifaliaChecks).toBe(0)
    expect(outcome.stats.spendCents).toBe(0)
    expect(outcome.results.map(r => r.status)).toEqual(['safe', 'invalid'])
  })

  // Rule 2: only Tier-B-shaped candidates earn a second opinion.
  it('escalates risky/unknown only when the name is high trust', async () => {
    const primary = stubProvider('verify-svc', {
      'trusted@x.com': 'risky',
      'weak@x.com': 'risky',
      'trusted2@x.com': 'unknown',
    })
    const fallback = stubProvider('verifalia', { 'trusted@x.com': 'safe', 'trusted2@x.com': 'invalid' })

    const hybrid = new HybridVerifier(primary, fallback, new MemoryBudgetLedger(), 500, silent)
    const outcome = await hybrid.verify('c1', [
      { email: 'trusted@x.com', highTrustName: true },
      { email: 'weak@x.com', highTrustName: false },
      { email: 'trusted2@x.com', highTrustName: true },
    ])

    expect(fallback.calls).toHaveLength(1)
    expect(new Set(fallback.calls[0])).toEqual(new Set(['trusted@x.com', 'trusted2@x.com']))

    const byEmail = Object.fromEntries(outcome.results.map(r => [r.email, r]))
    // The paid second opinion wins.
    expect(byEmail['trusted@x.com'].status).toBe('safe')
    expect(byEmail['trusted2@x.com'].status).toBe('invalid')
    // The low-trust one keeps the primary verdict untouched.
    expect(byEmail['weak@x.com'].status).toBe('risky')
    expect(byEmail['weak@x.com'].provider).toBe('verify-svc')
  })

  it('records both providers on a merged result', async () => {
    const primary = stubProvider('verify-svc', { 'a@x.com': 'unknown' })
    const fallback = stubProvider('verifalia', { 'a@x.com': 'safe' })

    const hybrid = new HybridVerifier(primary, fallback, new MemoryBudgetLedger(), 500, silent)
    const outcome = await hybrid.verify('c1', [{ email: 'a@x.com', highTrustName: true }])

    expect(outcome.results[0].provider).toBe('verify-svc+verifalia')
    expect(outcome.stats.bothRan).toBe(1)
    expect(outcome.stats.agreed).toBe(0)
  })

  it('counts agreement when both providers reach the same verdict', async () => {
    const primary = stubProvider('verify-svc', { 'a@x.com': 'risky', 'b@x.com': 'risky' })
    const fallback = stubProvider('verifalia', { 'a@x.com': 'risky', 'b@x.com': 'safe' })

    const hybrid = new HybridVerifier(primary, fallback, new MemoryBudgetLedger(), 500, silent)
    const outcome = await hybrid.verify('c1', [
      { email: 'a@x.com', highTrustName: true },
      { email: 'b@x.com', highTrustName: true },
    ])

    expect(outcome.stats.bothRan).toBe(2)
    expect(outcome.stats.agreed).toBe(1)
    expect(agreementRate(outcome.stats)).toBe(0.5)
  })
})

describe('hybrid budget cap', () => {
  it('stops escalating once the campaign cap is spent, keeping primary verdicts', async () => {
    const primary = stubProvider('verify-svc', { 'a@x.com': 'risky', 'b@x.com': 'risky' })
    const fallback = stubProvider('verifalia', { 'a@x.com': 'safe', 'b@x.com': 'safe' })

    const ledger = new MemoryBudgetLedger()
    await ledger.record('c1', 500) // cap already consumed

    const hybrid = new HybridVerifier(primary, fallback, ledger, 500, silent)
    const outcome = await hybrid.verify('c1', [
      { email: 'a@x.com', highTrustName: true },
      { email: 'b@x.com', highTrustName: true },
    ])

    expect(fallback.calls).toEqual([])
    expect(outcome.stats.budgetExhausted).toBe(true)
    expect(outcome.results.every(r => r.status === 'risky')).toBe(true)
    expect(outcome.results.every(r => r.detail?.includes('verifier_budget_exhausted'))).toBe(true)
  })

  it('escalates only as many as the remaining budget affords', async () => {
    const emails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']
    const primary = stubProvider('verify-svc',
      Object.fromEntries(emails.map(e => [e, 'risky' as VerifyStatus])))
    const fallback = stubProvider('verifalia',
      Object.fromEntries(emails.map(e => [e, 'safe' as VerifyStatus])))

    const ledger = new MemoryBudgetLedger()
    // Room for exactly two checks.
    const cap = VERIFALIA_COST_CENTS * 2
    const hybrid = new HybridVerifier(primary, fallback, ledger, cap, silent)

    const outcome = await hybrid.verify('c1', emails.map(email => ({ email, highTrustName: true })))

    expect(fallback.calls[0]).toHaveLength(2)
    expect(outcome.stats.verifaliaChecks).toBe(2)
    expect(outcome.stats.budgetExhausted).toBe(true)
    expect(await ledger.spentCents('c1')).toBeCloseTo(VERIFALIA_COST_CENTS * 2, 6)
  })

  it('prioritises risky over unknown when budget is scarce', async () => {
    const primary = stubProvider('verify-svc', {
      'unknown@x.com': 'unknown',
      'risky@x.com': 'risky',
    })
    const fallback = stubProvider('verifalia', { 'risky@x.com': 'safe' })

    const hybrid = new HybridVerifier(
      primary, fallback, new MemoryBudgetLedger(), VERIFALIA_COST_CENTS, silent,
    )
    await hybrid.verify('c1', [
      { email: 'unknown@x.com', highTrustName: true },
      { email: 'risky@x.com', highTrustName: true },
    ])

    expect(fallback.calls[0]).toEqual(['risky@x.com'])
  })

  it('keeps primary verdicts when the fallback is unavailable', async () => {
    const primary = stubProvider('verify-svc', { 'a@x.com': 'risky' })
    const fallback = stubProvider('verifalia', { 'a@x.com': 'safe' }, /* available */ false)

    const hybrid = new HybridVerifier(primary, fallback, new MemoryBudgetLedger(), 500, silent)
    const outcome = await hybrid.verify('c1', [{ email: 'a@x.com', highTrustName: true }])

    expect(fallback.calls).toEqual([])
    expect(outcome.results[0].status).toBe('risky')
    expect(outcome.results[0].provider).toBe('verify-svc')
  })
})
