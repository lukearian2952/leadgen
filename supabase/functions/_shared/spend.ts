// Per-campaign spend estimate.
//
// The gate makes the pipeline spend more per lead (extra Place Details fields,
// a crawl, up to two model calls, more Verifalia credits), so the cost has to
// be visible on the campaign row rather than discovered on an invoice.
//
// Rates are list prices at the time of writing. Anthropic's are exact; Google's
// vary with the SKU mix and Apify's with actor compute units, so treat the
// total as an estimate and the counters as the ground truth.

import type { Db } from './db.ts'

export const RATES = {
  /** Places Text Search, per request. */
  maps_text_search: 0.032,
  /** Place Details with Basic + Contact + Atmosphere fields, per request. */
  maps_place_details: 0.025,
  /** Verifalia, per address verified. Plan-dependent. */
  verifalia_credit: 0.003,
  /** claude-haiku-4-5, per input token ($1.00 / MTok). */
  haiku_input_token: 1.00 / 1_000_000,
  /** claude-haiku-4-5, per output token ($5.00 / MTok). */
  haiku_output_token: 5.00 / 1_000_000,
  /** Apify actor run. Nominal — real cost scales with compute units. */
  apify_run: 0.05,
  /** Site crawl fetches and DNS-over-HTTPS lookups are free. */
  page_fetch: 0,
  dns_lookup: 0,
} as const

export type SpendCounters = Partial<Record<keyof typeof RATES, number>>

export function estimateUsd(counters: SpendCounters): number {
  let total = 0
  for (const [key, count] of Object.entries(counters)) {
    total += (RATES[key as keyof typeof RATES] ?? 0) * (count ?? 0)
  }
  return Math.round(total * 10_000) / 10_000
}

/**
 * Accumulate spend onto the campaign row.
 *
 * Goes through the add_campaign_spend RPC rather than a read-modify-write from
 * here: owner-lookup self-chains and processes leads in parallel, so two
 * invocations can be adding at the same moment.
 */
export async function recordSpend(
  sb: Db,
  campaignId: string,
  counters: SpendCounters,
): Promise<void> {
  const cleaned: Record<string, number> = {}
  for (const [key, count] of Object.entries(counters)) {
    if (count) cleaned[key] = count
  }
  if (!Object.keys(cleaned).length) return

  await sb.rpc('add_campaign_spend', {
    p_campaign_id: campaignId,
    p_counters: cleaned,
    p_usd: estimateUsd(counters),
  })
}
