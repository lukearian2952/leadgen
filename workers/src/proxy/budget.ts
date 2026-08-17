// Per-campaign residential byte budget.
//
// Decodo bills by the gigabyte, and until proxy-meter existed the largest
// consumer — Maps discovery — was entirely unmeasured. ~3 GB went out with no
// per-stage attribution and nothing that could have stopped it.
//
// The budget is deliberately *per campaign* rather than global: a global cap
// makes one runaway campaign break every other one, and the operator cannot
// tell which was at fault. Per campaign, the damage is contained to the
// campaign that caused it and the report says so.
//
// Default is 2 GB per 1,000 target businesses, i.e. 2 MB each — twice the
// ≤1 MB target, so the budget is a backstop against a bug rather than a
// day-to-day constraint. A campaign hitting it is a signal, not routine.

import type { Pool } from 'pg'
import type { BudgetTracker } from './pool.js'
import type { Logger } from '../logger.js'

export const BYTES_PER_BUSINESS_BUDGET = 2_000_000

export function defaultBudgetBytes(targetCount: number): number {
  return Math.max(1, targetCount) * BYTES_PER_BUSINESS_BUDGET
}

/**
 * Database-backed tracker with a short-lived cache.
 *
 * `add` is authoritative and atomic — `add_residential_bytes` does the
 * increment and the comparison in one statement, so two crawl workers cannot
 * both read "under budget" and both spend. `isOver` reads the cached verdict,
 * because doing a round trip before every page fetch would cost more than the
 * bytes it saves.
 *
 * The cache means a campaign can overshoot slightly — by at most the bytes in
 * flight across concurrent workers between refreshes. That is the right trade:
 * the budget exists to stop a runaway, not to bill to the byte.
 */
export class DbBudgetTracker implements BudgetTracker {
  private over = new Map<string, boolean>()
  private lastCheck = new Map<string, number>()

  constructor(
    private readonly db: Pool,
    private readonly logger: Logger,
    private readonly cacheMs = 15_000,
  ) {}

  async add(campaignId: string, bytes: number) {
    try {
      const { rows } = await this.db.query<{ used: string; budget: string | null; over: boolean }>(
        `select * from add_residential_bytes($1, $2)`, [campaignId, bytes])
      const row = rows[0]
      const result = {
        over: Boolean(row?.over),
        used: Number(row?.used ?? 0),
        budget: Number(row?.budget ?? 0),
      }
      this.over.set(campaignId, result.over)
      this.lastCheck.set(campaignId, Date.now())
      if (result.over) {
        this.logger.warn('campaign residential budget exhausted', {
          campaignId,
          usedGb: Number((result.used / 1e9).toFixed(3)),
          budgetGb: Number((result.budget / 1e9).toFixed(3)),
        })
      }
      return result
    } catch (err) {
      // Accounting must not take down the crawl. A failure here means the
      // budget stops being enforced, which is logged loudly rather than
      // silently treated as "under budget forever".
      this.logger.warn('could not record residential bytes', {
        campaignId, err: (err as Error).message,
      })
      return { over: false, used: 0, budget: 0 }
    }
  }

  isOver(campaignId: string): boolean {
    return this.over.get(campaignId) === true
  }

  /** Refresh the cached verdict; called opportunistically by long stages. */
  async refresh(campaignId: string): Promise<boolean> {
    const last = this.lastCheck.get(campaignId) ?? 0
    if (Date.now() - last < this.cacheMs) return this.isOver(campaignId)
    const result = await this.add(campaignId, 0)
    return result.over
  }
}
