import { useCallback } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Start, pause and resume a campaign on the **v2 worker fleet**.
 *
 * ── What this replaced, and why it mattered ──────────────────────────────────
 *
 * This hook used to POST to the `campaign-orchestrator` Edge Function. That
 * function is still deployed and still works — and it drives **v1**: Google
 * Places API plus Apify actors, writing into the same `leads` table the worker
 * fleet uses. So the only button a user could press ran the pipeline this
 * rebuild replaced, at Places API prices, producing the bounce rate the v2 gate
 * exists to prevent.
 *
 * `start_campaign_v2` is a `security definer` RPC that checks `auth.uid()` owns
 * the campaign and enqueues the right discovery stage — `maps:discover` for a
 * brick-and-mortar niche, `saas:discover` for an online one. The browser cannot
 * and must not write to `graphile_worker` itself.
 *
 * The v1 Edge Functions are deliberately left deployed rather than deleted:
 * `campaign-export` is still the export path, and deleting the others is a
 * decision for whoever is sure no historical campaign needs them.
 */

/** The residential allowance a campaign gets unless told otherwise. */
export const DEFAULT_RESIDENTIAL_BUDGET_BYTES = 2_500_000_000

export interface StartResult {
  started: boolean
  stage: string | null
  reason?: string
}

export function useCampaignRunner() {
  const run = useCallback(async (
    campaignId: string,
    residentialBudgetBytes: number = DEFAULT_RESIDENTIAL_BUDGET_BYTES,
  ): Promise<StartResult> => {
    const { data, error } = await supabase.rpc('start_campaign_v2', {
      p_campaign_id: campaignId,
      p_residential_budget_bytes: residentialBudgetBytes,
    })

    // Surface failures instead of swallowing them — a silent error here was
    // indistinguishable from "started fine, still working".
    if (error) throw new Error(error.message)
    return data as StartResult
  }, [])

  /**
   * Pause, and actually stop the work.
   *
   * v1's Pause set `status = 'paused'` from the browser and relied on the
   * orchestrator loop to notice on its next hop. v2 has no such loop, so
   * pausing has to remove the queued jobs too — otherwise a "paused" campaign
   * runs happily to completion and the status is simply lying, which
   * HANDOFF §10.4 rates worse than a crash because it looks like an answer.
   */
  const stop = useCallback(async (campaignId: string) => {
    const { data, error } = await supabase.rpc('pause_campaign_v2', {
      p_campaign_id: campaignId,
    })
    if (error) throw new Error(error.message)
    return data as { paused: boolean; jobs_removed: number }
  }, [])

  /**
   * Resume is Start again.
   *
   * The RPC's `job_key` makes it idempotent — a double-click, a retry and a
   * Resume all collapse into the same queued row rather than three concurrent
   * scrapes — so there is no separate resume path to get wrong. This is the
   * same class of bug as v1's Resume, where the frontend wrote `status =
   * 'running'` first and raced the claim guards into a silent no-op.
   */
  const resume = useCallback((campaignId: string) => run(campaignId), [run])

  return { run, stop, resume }
}
