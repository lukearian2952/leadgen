// Hybrid verification routing, per brief §F.2.
//
//   1. verify-svc first, for everything.
//   2. `unknown` / `risky` on a Tier-B candidate (registry- or LinkedIn-named,
//      catch-all domain) gets a second opinion from Verifalia.
//   3. `invalid` and `safe` never go to Verifalia — the verdict is already
//      actionable and a credit spent on it buys nothing.
//   4. Verifalia spend is capped per campaign. On exhaustion we keep the
//      verify-svc verdict and flag the lead `verifier_budget_exhausted`.
//
// Rule 3 is the one that keeps this cheap. v1 verified every candidate address
// through Verifalia including six pattern guesses per lead; here the paid
// provider only ever sees addresses where a second opinion changes the answer.

import type { VerifierProvider, VerifyResult } from './types.js'
import { VERIFALIA_COST_CENTS } from './verifalia.js'
import type { Logger } from '../logger.js'

export interface Candidate {
  email: string
  /**
   * True when this address belongs to a lead whose name came from a registry
   * officer record or a LinkedIn profile — the high-trust name sources. Only
   * these earn a paid second opinion.
   */
  highTrustName: boolean
}

export interface HybridOutcome {
  results: VerifyResult[]
  /** Per-provider counts for the campaign report. */
  stats: {
    verifySvcChecks: number
    verifaliaChecks: number
    spendCents: number
    budgetExhausted: boolean
    /** Addresses where both providers ran, and how often they agreed. */
    bothRan: number
    agreed: number
    /**
     * Final verdict count per provider name, for the funnel. Answers "who
     * actually decided this contact", which `verifySvcChecks` cannot once a
     * second opinion overrides a first.
     */
    byProvider: Record<string, number>
    /** True when the primary could not run and the batch was rerouted wholesale. */
    reroutedToFallback: boolean
  }
}

export interface BudgetLedger {
  /** Cents already spent with Verifalia on this campaign. */
  spentCents(campaignId: string): Promise<number>
  record(campaignId: string, cents: number): Promise<void>
}

/** In-memory ledger. Real runs use the Postgres-backed one in ../jobs. */
export class MemoryBudgetLedger implements BudgetLedger {
  private spend = new Map<string, number>()
  async spentCents(campaignId: string) { return this.spend.get(campaignId) ?? 0 }
  async record(campaignId: string, cents: number) {
    this.spend.set(campaignId, (this.spend.get(campaignId) ?? 0) + cents)
  }
}

export class HybridVerifier {
  constructor(
    private readonly primary: VerifierProvider,
    private readonly fallback: VerifierProvider,
    private readonly ledger: BudgetLedger,
    private readonly maxCentsPerCampaign: number,
    private readonly logger: Logger,
    /**
     * True when the *primary* charges per check — i.e. VERIFIER=verifalia.
     *
     * The cap used to apply only to the fallback, on the assumption that the
     * primary is our own free service. Running Verifalia as primary under that
     * assumption spends without limit, which is exactly the configuration used
     * while port 25 is blocked.
     */
    private readonly primaryIsPaid = false,
  ) {}

  /** How many paid checks the remaining campaign budget allows. */
  private async affordableChecks(campaignId: string): Promise<number> {
    const spent = await this.ledger.spentCents(campaignId)
    return Math.max(0, Math.floor((this.maxCentsPerCampaign - spent) / VERIFALIA_COST_CENTS))
  }

  async verify(campaignId: string, candidates: Candidate[]): Promise<HybridOutcome> {
    const stats: HybridOutcome['stats'] = {
      verifySvcChecks: 0, verifaliaChecks: 0, spendCents: 0,
      budgetExhausted: false, bothRan: 0, agreed: 0,
      byProvider: {}, reroutedToFallback: false,
    }
    if (!candidates.length) return { results: [], stats }

    const byEmail = new Map(candidates.map(c => [c.email.toLowerCase(), c]))
    const emails = [...byEmail.keys()]

    // ── Rule 1: primary sees everything ──────────────────────────────────────
    let primaryResults: VerifyResult[]

    if (this.primaryIsPaid) {
      const affordable = await this.affordableChecks(campaignId)
      if (affordable <= 0) {
        stats.budgetExhausted = true
        this.logger.warn('paid primary verifier is over budget — nothing verified', {
          campaignId, cap: this.maxCentsPerCampaign, wanted: emails.length,
        })
        const results = emails.map(e => budgetBlocked(e, this.primary.name))
        stats.byProvider = tally(results)
        return { results, stats }
      }

      const within = emails.slice(0, affordable)
      const beyond = emails.slice(affordable)
      if (beyond.length) {
        stats.budgetExhausted = true
        this.logger.warn('paid primary verifier capped mid-batch', {
          campaignId, verified: within.length, skipped: beyond.length,
        })
      }

      const ran = await this.primary.verify(within)
      stats.spendCents = ran.reduce((sum, r) => sum + r.cost_cents, 0)
      if (stats.spendCents > 0) await this.ledger.record(campaignId, stats.spendCents)

      primaryResults = [...ran, ...beyond.map(e => budgetBlocked(e, this.primary.name))]
      stats.verifaliaChecks = ran.length
    } else {
      primaryResults = await this.primary.verify(emails)
      stats.verifySvcChecks = primaryResults.length
    }

    // ── The primary could not run at all ─────────────────────────────────────
    //
    // Distinct from "ran and was inconclusive". A fleet condition — every IP
    // cooling, the service unreachable — invalidates the whole batch, so the
    // whole batch reroutes rather than the high-trust slice Rule 2 would pick.
    const allUnavailable = primaryResults.length > 0 && primaryResults.every(r => r.unavailable)

    if (allUnavailable && !this.primaryIsPaid) {
      const rerouted = await this.rerouteAll(campaignId, primaryResults, stats)
      if (rerouted) return rerouted
    }

    // ── Rules 2 + 3: who deserves a second opinion ───────────────────────────
    const escalate = primaryResults.filter(result => {
      // Rule 3 — a decided verdict is final.
      if (result.status === 'safe' || result.status === 'invalid') return false
      // Rule 2 — only Tier-B-shaped candidates, i.e. a high-trust name.
      const candidate = byEmail.get(result.email)
      if (!candidate?.highTrustName) return false
      return result.status === 'unknown' || result.status === 'risky'
    })

    if (!escalate.length) {
      stats.byProvider = tally(primaryResults)
      return { results: primaryResults, stats }
    }

    // ── Rule 4: budget ───────────────────────────────────────────────────────
    const alreadySpent = await this.ledger.spentCents(campaignId)
    const remainingCents = this.maxCentsPerCampaign - alreadySpent
    const affordable = Math.max(0, Math.floor(remainingCents / VERIFALIA_COST_CENTS))

    if (affordable <= 0) {
      stats.budgetExhausted = true
      this.logger.warn('Verifalia budget exhausted for campaign — keeping verify-svc verdicts', {
        campaignId, alreadySpent, cap: this.maxCentsPerCampaign, wanted: escalate.length,
      })
      const results = primaryResults.map(flagExhausted)
      stats.byProvider = tally(results)
      return { results, stats }
    }

    if (!await this.fallback.available()) {
      this.logger.warn('Verifalia unavailable — keeping verify-svc verdicts', { campaignId })
      stats.byProvider = tally(primaryResults)
      return { results: primaryResults, stats }
    }

    // Spend the budget on the most valuable escalations first: `risky` is a
    // near-miss that a second opinion often converts, `unknown` frequently
    // stays unknown.
    const ordered = [...escalate].sort((a, b) =>
      (a.status === 'risky' ? 0 : 1) - (b.status === 'risky' ? 0 : 1))
    const toEscalate = ordered.slice(0, affordable)
    if (toEscalate.length < escalate.length) stats.budgetExhausted = true

    const secondOpinions = await this.fallback.verify(toEscalate.map(r => r.email))
    stats.verifaliaChecks += secondOpinions.length
    stats.spendCents += secondOpinions.reduce((sum, r) => sum + r.cost_cents, 0)
    await this.ledger.record(campaignId, stats.spendCents)

    const secondByEmail = new Map(secondOpinions.map(r => [r.email.toLowerCase(), r]))

    const merged = primaryResults.map(primary => {
      const second = secondByEmail.get(primary.email)
      if (!second) {
        return stats.budgetExhausted && isEscalatable(primary, byEmail)
          ? flagExhausted(primary)
          : primary
      }

      stats.bothRan++
      if (second.status === primary.status) stats.agreed++

      // The paid second opinion wins — it is the reason we asked.
      return {
        ...second,
        provider: `${primary.provider}+${second.provider}`,
        detail: [primary.detail, second.detail].filter(Boolean).join(' | '),
      }
    })

    stats.byProvider = tally(merged)
    return { results: merged, stats }
  }

  /**
   * Send an entire batch to the fallback because the primary could not run.
   *
   * Returns null when the fallback cannot take it — no credentials, or no
   * budget — in which case the caller keeps the primary's `unavailable`
   * verdicts. Those cannot reach Tier A, which is the correct outcome: an
   * unverified address must never be exported as verified.
   */
  private async rerouteAll(
    campaignId: string, primaryResults: VerifyResult[], stats: HybridOutcome['stats'],
  ): Promise<HybridOutcome | null> {
    if (!await this.fallback.available()) {
      this.logger.error(
        'primary verifier unavailable and no fallback is configured — batch unverified',
        undefined, { campaignId, addresses: primaryResults.length })
      stats.byProvider = tally(primaryResults)
      return { results: primaryResults, stats }
    }

    const affordable = await this.affordableChecks(campaignId)
    if (affordable <= 0) {
      stats.budgetExhausted = true
      this.logger.warn('primary unavailable and fallback budget exhausted', {
        campaignId, cap: this.maxCentsPerCampaign,
      })
      const results = primaryResults.map(flagExhausted)
      stats.byProvider = tally(results)
      return { results, stats }
    }

    const emails = primaryResults.map(r => r.email)
    const within = emails.slice(0, affordable)
    const beyond = emails.slice(affordable)
    if (beyond.length) stats.budgetExhausted = true

    this.logger.warn('primary verifier unavailable — rerouting the whole batch to the fallback', {
      campaignId, rerouted: within.length, overBudget: beyond.length,
    })

    const fallbackResults = await this.fallback.verify(within)
    stats.verifaliaChecks += fallbackResults.length
    stats.spendCents += fallbackResults.reduce((sum, r) => sum + r.cost_cents, 0)
    if (stats.spendCents > 0) await this.ledger.record(campaignId, stats.spendCents)
    stats.reroutedToFallback = true

    const byEmail = new Map(fallbackResults.map(r => [r.email.toLowerCase(), r]))
    const results = primaryResults.map(p => byEmail.get(p.email) ?? flagExhausted(p))
    stats.byProvider = tally(results)
    return { results, stats }
  }
}

/** Count final verdicts per provider, for the funnel. */
function tally(results: VerifyResult[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of results) out[r.provider] = (out[r.provider] ?? 0) + 1
  return out
}

/** An address that was never checked because the budget would not cover it. */
function budgetBlocked(email: string, provider: string): VerifyResult {
  return {
    email, status: 'unknown', is_catch_all: false, is_disposable: false,
    is_role: false, provider, latency_ms: 0, cost_cents: 0,
    detail: 'verifier_budget_exhausted — not checked', unavailable: true,
  }
}

function isEscalatable(result: VerifyResult, byEmail: Map<string, Candidate>): boolean {
  const candidate = byEmail.get(result.email)
  return Boolean(candidate?.highTrustName) &&
    (result.status === 'unknown' || result.status === 'risky')
}

function flagExhausted(result: VerifyResult): VerifyResult {
  if (result.status === 'safe' || result.status === 'invalid') return result
  return {
    ...result,
    detail: [result.detail, 'verifier_budget_exhausted'].filter(Boolean).join(' | '),
  }
}

/** Agreement rate on the sample where both providers ran, for the phase report. */
export function agreementRate(stats: HybridOutcome['stats']): number | null {
  if (!stats.bothRan) return null
  return stats.agreed / stats.bothRan
}
