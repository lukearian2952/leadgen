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
  ) {}

  async verify(campaignId: string, candidates: Candidate[]): Promise<HybridOutcome> {
    const stats = {
      verifySvcChecks: 0, verifaliaChecks: 0, spendCents: 0,
      budgetExhausted: false, bothRan: 0, agreed: 0,
    }
    if (!candidates.length) return { results: [], stats }

    const byEmail = new Map(candidates.map(c => [c.email.toLowerCase(), c]))

    // ── Rule 1: primary sees everything ──────────────────────────────────────
    const primaryResults = await this.primary.verify([...byEmail.keys()])
    stats.verifySvcChecks = primaryResults.length

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
      return { results: primaryResults.map(flagExhausted), stats }
    }

    if (!await this.fallback.available()) {
      this.logger.warn('Verifalia unavailable — keeping verify-svc verdicts', { campaignId })
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
    stats.verifaliaChecks = secondOpinions.length
    stats.spendCents = secondOpinions.reduce((sum, r) => sum + r.cost_cents, 0)
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

    return { results: merged, stats }
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
