// Provider mailbox lookup — the last item on the build list.
//
// It exists because 176 businesses (12.5% of everything processed) are named
// and unmailable, and 205 of 209 Tier C rows have no mailbox at all rather than
// one that failed. The pattern ladder is exhausted, not unlucky:
// PATTERN_LADDER_EXTRAS measured zero recovery for 2.6x the verification spend.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HunterProvider, makeMailboxProvider } from '../src/sources/mailbox-provider.js'

const logger = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return this },
} as never

const cfg = (over = {}) => ({ mailboxProvider: '', hunterApiKey: '', ...over }) as never

describe('makeMailboxProvider', () => {
  it('is null with no key — the state the pipeline ran in until now', () => {
    expect(makeMailboxProvider(cfg(), logger)).toBeNull()
  })

  it('selects Hunter on the key alone', () => {
    const p = makeMailboxProvider(cfg({ hunterApiKey: 'k' }), logger)
    expect(p?.name).toBe('hunter')
    expect(p?.centsPerLookup).toBeGreaterThan(0)
  })

  it('refuses an unknown provider rather than silently using Hunter', () => {
    const warn = vi.fn()
    const noisy = { info() {}, warn, error() {}, debug() {}, child() { return this } } as never
    expect(makeMailboxProvider(
      cfg({ hunterApiKey: 'k', mailboxProvider: 'apollo' }), noisy)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

describe('HunterProvider.find', () => {
  it('needs a domain and both name parts', async () => {
    const p = new HunterProvider('k', logger)
    expect(await p.find('', 'A', 'B')).toBeNull()
    expect(await p.find('d.com', '', 'B')).toBeNull()
    expect(await p.find('d.com', 'A', '')).toBeNull()
  })

  it('reports sources so an inferred address is distinguishable from a seen one', () => {
    // Hunter returned robb@inkworksfw.com with score 80 and **sources: 0** on a
    // real Tier C lead: it inferred the address the same way our ladder does.
    // The field is carried so that is visible rather than assumed.
    const shape = { email: 'a@b.com', score: 80, sources: 0, providerStatus: 'valid' }
    expect(shape.sources).toBe(0)
    expect(shape.providerStatus).toBe('valid')
  })
})

describe('a provider address does not bypass the gate', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/jobs/enrich-lead.ts', import.meta.url)), 'utf8')

  it('is verified through the same router, not trusted from the provider', () => {
    // The found address goes into verifier.verify like any candidate. If this
    // ever becomes a direct assignment to chosen/owner_email, email_status
    // stops meaning "our verdict" and starts meaning "a vendor's".
    expect(src).toMatch(/const extra = await verifier\.verify\(\s*\n?\s*campaignId, \[\{ email: found/)
  })

  it('the provider verdict is recorded but never gates', () => {
    expect(src).toContain('provider_status: providerLookup?.providerStatus ?? null')
    // No branch anywhere keys a tier or a gate decision off the provider field.
    expect(src).not.toMatch(/if\s*\(\s*providerLookup\?\.providerStatus/)
    expect(src).not.toMatch(/providerLookup\.score\s*[><]/)
  })

  it('is bought only after the free ladder failed', () => {
    const guard = src.indexOf('if (!deliverable(outcome.results, toCheck)) {')
    const call = src.indexOf('await provider.find(')
    expect(guard).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(guard)
  })

  it('admits only addresses the provider has actually seen', () => {
    // 46 hits over 189 leads; 13 had sources > 0. The other 33 were inferred
    // from the domain pattern — which is what candidateLadder already did, and
    // on a catch-all domain an inferred address reaches Tier B on the
    // concession rather than on evidence.
    expect(src).toContain('const PROVIDER_MIN_SOURCES = 1')
    expect(src).toContain(
      'const observed = (providerLookup?.sources ?? 0) >= PROVIDER_MIN_SOURCES')
    // The verify call is gated on it, not merely logged.
    expect(src).toMatch(/if \(found && observed && !toCheck\.includes\(found\)/)
  })

  it('records the ignored ones rather than dropping them silently', () => {
    expect(src).toContain('provider address ignored — inferred, not observed')
    expect(src).toContain('provider_observed')
  })

  it('is capped per campaign and metered even on a miss', () => {
    expect(src).toContain('hunterMaxLookupsPerCampaign')
    expect(src).toContain("'provider_lookup'")
    // The add_source_cost call sits outside any `if (found)` branch.
    const meter = src.indexOf("[campaignId, 'provider_lookup'")
    const foundBranch = src.indexOf('const found = providerLookup?.email')
    expect(meter).toBeLessThan(foundBranch)
  })
})
