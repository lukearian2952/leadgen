// verify:batch — run a set of candidate addresses through the hybrid verifier.
//
// Only leads that already have a name are verified, per §F.2: a verification on
// a nameless lead can never produce a Tier A or B row, so the check is pure
// cost. v1 spent Verifalia credits on general inboxes for exactly this reason
// and got nothing back.

import type { Task } from 'graphile-worker'
import type { Pool } from 'pg'
import { wrapTask } from './wrap.js'
import type { TaskDeps } from './index.js'
import { HybridVerifier, type BudgetLedger, type Candidate } from '../verify/hybrid.js'
import { VerifySvcProvider } from '../verify/verifysvc.js'
import { VerifaliaProvider } from '../verify/verifalia.js'
import type { VerifierProvider, VerifyResult } from '../verify/types.js'
import type { Logger } from '../logger.js'
import type { Config } from '../config.js'

interface VerifyBatchPayload {
  campaignId: string
  candidates: Candidate[]
  [key: string]: unknown
}

/**
 * Verifalia spend, accumulated in Postgres.
 *
 * Has to be shared state: with more than one verify replica an in-memory
 * counter would let each worker spend the full cap independently.
 */
export class PgBudgetLedger implements BudgetLedger {
  constructor(private readonly db: Pool) {}

  async spentCents(campaignId: string): Promise<number> {
    const { rows } = await this.db.query<{ cents: string }>(
      `select coalesce(sum(cost_cents), 0)::text as cents
         from source_costs
        where campaign_id = $1 and source = 'verifalia'`,
      [campaignId],
    )
    return Number(rows[0]?.cents ?? 0)
  }

  async record(campaignId: string, cents: number): Promise<void> {
    if (cents <= 0) return
    await this.db.query(
      `select add_source_cost($1, 'verifalia', 'verify', 0, 0, 0, 0, $2)`,
      [campaignId, cents],
    )
  }
}

export function buildVerifier(config: Config, db: Pool, logger: Logger) {
  const svc = new VerifySvcProvider(config.verify.url, logger)
  const verifalia = new VerifaliaProvider(
    config.verifalia.username, config.verifalia.password, logger,
  )

  // VERIFIER selects the topology. 'reacher' is retained as an alias for the
  // self-hosted provider so existing config keeps working after the swap from
  // Reacher to verify-svc.
  if (config.verifier === 'verifalia') {
    return new HybridVerifier(
      verifalia, noopProvider(), new PgBudgetLedger(db),
      config.verifalia.maxCentsPerCampaign, logger,
    )
  }
  if (config.verifier === 'reacher') {
    return new HybridVerifier(
      svc, noopProvider(), new PgBudgetLedger(db), 0, logger,
    )
  }
  return new HybridVerifier(
    svc, verifalia, new PgBudgetLedger(db),
    config.verifalia.maxCentsPerCampaign, logger,
  )
}

/** Stands in for the fallback when the topology has only one provider. */
function noopProvider(): VerifierProvider {
  return {
    name: 'none',
    async available() { return false },
    async verify() { return [] as VerifyResult[] },
  }
}

export function makeVerifyBatchTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<VerifyBatchPayload>({ stage: 'verify:batch', db }, async (payload, ctx) => {
    const { campaignId, candidates } = payload
    if (!campaignId) throw new Error('verify:batch requires campaignId')
    if (!candidates?.length) {
      ctx.logger.info('verify:batch called with no candidates')
      return
    }

    const verifier = buildVerifier(config, db, ctx.logger)
    const outcome = await verifier.verify(campaignId, candidates)

    ctx.cost.cents = outcome.stats.spendCents
    ctx.cost.detail = {
      verify_svc_checks: outcome.stats.verifySvcChecks,
      verifalia_checks:  outcome.stats.verifaliaChecks,
      both_ran:          outcome.stats.bothRan,
      agreed:            outcome.stats.agreed,
      budget_exhausted:  outcome.stats.budgetExhausted,
    }

    await db.query(
      `select add_source_cost($1, 'verify-svc', 'verify', $2, 0, 0, 0, 0)`,
      [campaignId, outcome.stats.verifySvcChecks],
    )

    ctx.logger.info('verification batch complete', {
      candidates: candidates.length,
      ...ctx.cost.detail,
    })

    // Phase 2 writes these onto `contacts` with their tier. Phase 1 stops here
    // — the persistence target does not exist yet, and inventing a shape now
    // would be rewritten next phase.
  })
}
