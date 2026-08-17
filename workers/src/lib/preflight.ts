// Predicting Tier-A yield from the on-domain-personal-address census.
//
// ── The finding this rests on ────────────────────────────────────────────────
//
// Three campaigns, same pipeline:
//
//   niche         businesses   on-domain personal   named      Tier A
//   med spa            75              2 (2.7%)     42.7%    1 (1.3%)
//   dental             79             12 (15.2%)    51.9%    5 (6.3%)
//   vehicle wrap      100             13 (13.0%)    34.0%    9 (9.0%)
//
// The census rises 2.7 → 15.2 → 13.0 and Tier A rises 1.3 → 6.3 → 9.0.
// Named-rate does the opposite of tracking it: wrap has the lowest named-rate
// and the highest Tier A. So the question worth asking before spending a
// campaign is "do these businesses own their mail", and twenty crawls answer
// it.
//
// ── Why a band and not a number ──────────────────────────────────────────────
//
// Three points, two of which are close together, over a range that is not
// obviously linear. Fitting a line through that and reporting "predicted Tier
// A: 6.2%" would be false precision — the honest output is a band wide enough
// to contain the observed spread, and a label a human can act on.

export interface CalibrationPoint {
  niche: string
  sampleSize: number
  /** Businesses with ≥1 personal address on their own domain, per 100. */
  onDomainPersonalRate: number
  tierARate: number
}

export const SEED_CALIBRATION: CalibrationPoint[] = [
  { niche: 'med spa',           sampleSize: 75,  onDomainPersonalRate: 2.667,  tierARate: 1.333 },
  { niche: 'dental practice',   sampleSize: 79,  onDomainPersonalRate: 15.190, tierARate: 6.329 },
  { niche: 'vehicle wrap shop', sampleSize: 100, onDomainPersonalRate: 13.000, tierARate: 9.000 },
]

export type YieldBand = 'poor' | 'moderate' | 'good'

export interface Prediction {
  /** Percent of scraped businesses expected to reach Tier A. */
  low: number
  high: number
  band: YieldBand
  /** Plain-language summary for the campaign builder. */
  summary: string
  /** How many calibration points backed this. */
  basedOn: number
}

/**
 * Thresholds on the census rate, taken from where the observed points actually
 * sit rather than from round numbers:
 *
 *   ≤ 5%   — med spa territory. 1 Tier A per 75. Do not sell into this.
 *   5–10%  — between the two clusters; no direct observation, hence the widest
 *            band and the explicit warning.
 *   ≥ 10%  — dental and wrap territory: 6–9 Tier A per 100.
 */
export const POOR_MAX = 5
export const MODERATE_MAX = 10

/**
 * Predict from a census rate.
 *
 * `points` lets a caller pass the live calibration table; it defaults to the
 * three seeded observations. Points are used to set the band edges, so as
 * campaigns finish the prediction sharpens rather than staying frozen at what
 * we knew in August.
 */
export function predictTierA(
  onDomainPersonalRate: number,
  points: readonly CalibrationPoint[] = SEED_CALIBRATION,
): Prediction {
  const sorted = [...points].sort((a, b) => a.onDomainPersonalRate - b.onDomainPersonalRate)
  const basedOn = sorted.length

  if (!basedOn) {
    return {
      low: 0, high: 100, band: 'moderate', basedOn: 0,
      summary: 'No calibration data yet — this campaign will create the first point.',
    }
  }

  const lowCluster = sorted.filter(p => p.onDomainPersonalRate <= POOR_MAX)
  const highCluster = sorted.filter(p => p.onDomainPersonalRate >= MODERATE_MAX)
  const rateOf = (ps: readonly CalibrationPoint[]) => ps.map(p => p.tierARate)

  if (onDomainPersonalRate <= POOR_MAX) {
    const observed = rateOf(lowCluster.length ? lowCluster : sorted.slice(0, 1))
    return {
      low: 0,
      high: Math.max(...observed, 2),
      band: 'poor',
      basedOn,
      summary:
        `Only ${onDomainPersonalRate.toFixed(1)}% of these businesses publish a personal ` +
        'address on their own domain. The closest measured niche at this level (med spa) ' +
        'produced 1 Tier A from 75 businesses. Expect almost all yield to be Tier B — ' +
        'named owners at published or catch-all addresses — not Tier A.',
    }
  }

  if (onDomainPersonalRate < MODERATE_MAX) {
    const all = rateOf(sorted)
    return {
      low: Math.min(...all),
      high: Math.max(...all),
      band: 'moderate',
      basedOn,
      summary:
        `${onDomainPersonalRate.toFixed(1)}% publish a personal address on their own domain — ` +
        'between the niches measured so far, with no direct observation at this level. ' +
        'Treat the range as wide and the campaign as itself a measurement.',
    }
  }

  const observed = rateOf(highCluster.length ? highCluster : sorted.slice(-1))
  return {
    low: Math.min(...observed),
    high: Math.max(...observed),
    band: 'good',
    basedOn,
    summary:
      `${onDomainPersonalRate.toFixed(1)}% publish a personal address on their own domain, ` +
      'in the range where dental and vehicle wrap produced 6–9 Tier A per 100 businesses. ' +
      'This niche owns its mail; the pipeline converts it.',
  }
}

/**
 * Cost estimate for a campaign of `targetCount`.
 *
 * Measured cost per business across the three completed campaigns was $0.0129,
 * $0.0167 and $0.0136. The band is those extremes, not an average, because a
 * quote that is right on average and low half the time is worse than a range.
 */
export const COST_PER_BUSINESS_LOW = 0.0129
export const COST_PER_BUSINESS_HIGH = 0.0167

export function estimateCost(targetCount: number): { low: number; high: number } {
  return {
    low: Number((targetCount * COST_PER_BUSINESS_LOW).toFixed(2)),
    high: Number((targetCount * COST_PER_BUSINESS_HIGH).toFixed(2)),
  }
}

/** The census numbers a preflight crawl produces. */
export interface CensusResult {
  businessesFound: number
  businessesWithSite: number
  addressesSeen: number
  onDomainAddresses: number
  onDomainPersonal: number
  businessesWithPersonal: number
  named: number
}

export function censusRate(c: CensusResult): number {
  if (!c.businessesFound) return 0
  return (c.businessesWithPersonal / c.businessesFound) * 100
}
