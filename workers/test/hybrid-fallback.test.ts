// Routing when the primary verifier cannot run, and budget enforcement when the
// paid provider is the primary.
//
// Both paths exist because of real failures: an entire Phase 2 run produced
// zero Tier A rows with the fallback sitting unused, and the VERIFIER=verifalia
// topology applied the per-campaign cap only to a fallback that was never
// called — so the cap did not bind at all.

import { describe, it, expect } from 'vitest'
import { HybridVerifier, MemoryBudgetLedger } from '../src/verify/hybrid.js'
import { VERIFALIA_COST_CENTS } from '../src/verify/verifalia.js'
import type { VerifierProvider, VerifyResult, VerifyStatus } from '../src/verify/types.js'
import { Logger } from '../src/logger.js'

const silent = new Logger('error')

function result(
  email: string, status: VerifyStatus, provider: string, extra: Partial<VerifyResult> = {},
): VerifyResult {
  return {
    email, status, provider,
    is_catch_all: false, is_disposable: false, is_role: false,
    latency_ms: 1,
    cost_cents: provider === 'verifalia' ? VERIFALIA_COST_CENTS : 0,
    ...extra,
  }
}

/** A provider that cannot run — every result flagged `unavailable`. */
function deadProvider(name: string): VerifierProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name, calls,
    async available() { return true },
    async verify(emails) {
      calls.push([...emails])
      return emails.map(e => result(e, 'unknown', name, { unavailable: true, detail: 'all verifier IPs cooling' }))
    },
  }
}

/** A provider that runs and reaches no conclusion — NOT the same thing. */
function inconclusiveProvider(name: string): VerifierProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name, calls,
    async available() { return true },
    async verify(emails) {
      calls.push([...emails])
      return emails.map(e => result(e, 'unknown', name))
    },
  }
}

function workingProvider(
  name: string, verdicts: Record<string, VerifyStatus> = {},
): VerifierProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name, calls,
    async available() { return true },
    async verify(emails) {
      calls.push([...emails])
      return emails.map(e => result(e, verdicts[e] ?? 'safe', name))
    },
  }
}

const lowTrust = (emails: string[]) => emails.map(email => ({ email, highTrustName: false }))

describe('rerouting when the primary cannot run', () => {
  it('sends the whole batch to the fallback, not just high-trust names', async () => {
    const primary = deadProvider('verify-svc')
    const fallback = workingProvider('verifalia', { 'a@x.com': 'safe', 'b@x.com': 'invalid' })

    const hybrid = new HybridVerifier(
      primary, fallback, new MemoryBudgetLedger(), 500, silent, false)

    // Deliberately low-trust: Rule 2 would normally escalate none of these.
    const outcome = await hybrid.verify('c1', lowTrust(['a@x.com', 'b@x.com']))

    expect(fallback.calls).toHaveLength(1)
    expect(fallback.calls[0].sort()).toEqual(['a@x.com', 'b@x.com'])
    expect(outcome.stats.reroutedToFallback).toBe(true)
    expect(outcome.results.find(r => r.email === 'a@x.com')?.status).toBe('safe')
    expect(outcome.results.every(r => r.provider === 'verifalia')).toBe(true)
  })

  it('does NOT reroute when the primary ran and was merely inconclusive', async () => {
    // The distinction that matters: an inconclusive verdict is a real answer,
    // and paying to re-ask it for every low-trust address is how the credit
    // budget disappears.
    const primary = inconclusiveProvider('verify-svc')
    const fallback = workingProvider('verifalia')

    const hybrid = new HybridVerifier(
      primary, fallback, new MemoryBudgetLedger(), 500, silent, false)

    const outcome = await hybrid.verify('c1', lowTrust(['a@x.com', 'b@x.com']))

    expect(fallback.calls).toHaveLength(0)
    expect(outcome.stats.reroutedToFallback).toBe(false)
    expect(outcome.stats.spendCents).toBe(0)
  })

  it('honours the per-campaign cap when rerouting', async () => {
    const primary = deadProvider('verify-svc')
    const fallback = workingProvider('verifalia')
    const ledger = new MemoryBudgetLedger()

    // Enough budget for exactly two checks.
    const cap = VERIFALIA_COST_CENTS * 2
    const hybrid = new HybridVerifier(primary, fallback, ledger, cap, silent, false)

    const outcome = await hybrid.verify('c1',
      lowTrust(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']))

    expect(fallback.calls[0]).toHaveLength(2)
    expect(outcome.stats.budgetExhausted).toBe(true)
    // The two that could not be checked must not look verified.
    const unchecked = outcome.results.filter(r => r.detail?.includes('budget'))
    expect(unchecked).toHaveLength(2)
    expect(unchecked.every(r => r.status === 'unknown')).toBe(true)
  })

  it('keeps the unverified verdicts when there is no fallback at all', async () => {
    const primary = deadProvider('verify-svc')
    const none: VerifierProvider = {
      name: 'none',
      async available() { return false },
      async verify() { return [] },
    }

    const hybrid = new HybridVerifier(primary, none, new MemoryBudgetLedger(), 500, silent, false)
    const outcome = await hybrid.verify('c1', lowTrust(['a@x.com']))

    // Unknown is the honest answer; it cannot reach Tier A, which is the point.
    expect(outcome.results[0].status).toBe('unknown')
    expect(outcome.stats.reroutedToFallback).toBe(false)
    expect(outcome.stats.spendCents).toBe(0)
  })
})

describe('paid primary (VERIFIER=verifalia)', () => {
  it('applies the per-campaign cap to the primary', async () => {
    const verifalia = workingProvider('verifalia')
    const none: VerifierProvider = {
      name: 'none', async available() { return false }, async verify() { return [] },
    }
    const ledger = new MemoryBudgetLedger()

    const cap = VERIFALIA_COST_CENTS * 3
    const hybrid = new HybridVerifier(verifalia, none, ledger, cap, silent, true)

    const outcome = await hybrid.verify('c1',
      lowTrust(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']))

    expect(verifalia.calls[0]).toHaveLength(3)
    expect(outcome.stats.budgetExhausted).toBe(true)
    expect(outcome.stats.verifaliaChecks).toBe(3)
    expect(await ledger.spentCents('c1')).toBeCloseTo(VERIFALIA_COST_CENTS * 3, 5)
  })

  it('spends nothing once the campaign is already over budget', async () => {
    const verifalia = workingProvider('verifalia')
    const none: VerifierProvider = {
      name: 'none', async available() { return false }, async verify() { return [] },
    }
    const ledger = new MemoryBudgetLedger()
    await ledger.record('c1', 500) // cap already consumed

    const hybrid = new HybridVerifier(verifalia, none, ledger, 500, silent, true)
    const outcome = await hybrid.verify('c1', lowTrust(['a@x.com']))

    expect(verifalia.calls).toHaveLength(0)
    expect(outcome.stats.spendCents).toBe(0)
    expect(outcome.stats.budgetExhausted).toBe(true)
    expect(outcome.results[0].status).toBe('unknown')
  })

  it('accumulates spend across batches within one campaign', async () => {
    const verifalia = workingProvider('verifalia')
    const none: VerifierProvider = {
      name: 'none', async available() { return false }, async verify() { return [] },
    }
    const ledger = new MemoryBudgetLedger()
    const cap = VERIFALIA_COST_CENTS * 4
    const hybrid = new HybridVerifier(verifalia, none, ledger, cap, silent, true)

    await hybrid.verify('c1', lowTrust(['a@x.com', 'b@x.com', 'c@x.com']))
    const second = await hybrid.verify('c1', lowTrust(['d@x.com', 'e@x.com', 'f@x.com']))

    // Three spent in the first batch leaves room for exactly one more.
    expect(verifalia.calls[1]).toHaveLength(1)
    expect(second.stats.budgetExhausted).toBe(true)
  })
})

describe('provider attribution for the funnel', () => {
  it('reports which provider produced each final verdict', async () => {
    const primary = workingProvider('verify-svc', { 'a@x.com': 'safe', 'b@x.com': 'risky' })
    const fallback = workingProvider('verifalia', { 'b@x.com': 'safe' })

    const hybrid = new HybridVerifier(
      primary, fallback, new MemoryBudgetLedger(), 500, silent, false)

    const outcome = await hybrid.verify('c1', [
      { email: 'a@x.com', highTrustName: true },
      { email: 'b@x.com', highTrustName: true },
    ])

    // a was decided by verify-svc; b was escalated, so the paid verdict wins and
    // the merged provider records both.
    expect(outcome.stats.byProvider['verify-svc']).toBe(1)
    expect(outcome.stats.byProvider['verify-svc+verifalia']).toBe(1)
  })
})
