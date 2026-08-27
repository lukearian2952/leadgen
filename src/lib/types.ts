export type CampaignStatus =
  | 'pending' | 'running' | 'paused' | 'completed' | 'failed'
  /** Finished, but under 25% of scraped businesses produced a mailable owner. */
  | 'completed_low_yield'

/** Terminal states where the campaign did its work. */
export const FINISHED_STATUSES: CampaignStatus[] = ['completed', 'completed_low_yield']

export function isFinished(status: CampaignStatus): boolean {
  return FINISHED_STATUSES.includes(status)
}

/**
 * What a lead is worth, and how far it can be trusted.
 *
 * The v1 UI rendered a boolean `gate_passed`. v2 splits that into four, because
 * "not Tier A" covers two very different things: a row that is sendable with a
 * caveat, and a row that names a person we cannot reach.
 */
export type Tier = 'A' | 'B' | 'C' | 'rejected'

export const TIER_LABEL: Record<Tier, string> = {
  A: 'Verified',
  B: 'Sendable, with a caveat',
  C: 'Named, not reachable',
  rejected: 'Rejected',
}

export const TIER_DESCRIPTION: Record<Tier, string> = {
  A: 'An owner-grade name and a mailbox Verifalia classified exactly Deliverable. Send to these.',
  B: 'Sendable, but the caveat is real: either the domain is catch-all, so the ' +
     'address cannot be individually confirmed, or it is a freemail address the ' +
     'business genuinely runs on. Expect a higher bounce rate than Tier A.',
  C: 'We know who runs this business but have no address that reaches them. ' +
     'Useful for a different channel, not for email.',
  rejected: 'Did not clear the gate. The reason is on the row.',
}

/** Tiers that may be exported for sending. */
export const SENDABLE_TIERS: Tier[] = ['A', 'B']

export interface Campaign {
  id: string
  user_id: string
  niche: string
  location: string
  target_count: number
  status: CampaignStatus
  current_step: number
  step1_done: number
  // headline yield
  stat_owner_ready: number
  /** Residential proxy bytes spent. Budgeted per campaign. */
  residential_used_bytes: number
  residential_budget_bytes: number | null
  stat_rejected: number
  stat_dropped_step1: number
  stat_emails: number
  stat_owners: number
  // cost
  spend_estimate_usd: number
  spend_detail: Record<string, number> | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export interface Lead {
  id: string
  campaign_id: string
  business_name: string
  phone: string
  website: string
  place_id: string
  city: string
  state: string
  country: string
  formatted_address: string
  place_types: string[] | null
  business_status: string
  rating_count: number
  // owner identity
  owner_first_name: string
  owner_last_name: string
  owner_name: string
  owner_email: string
  title: string
  is_doctor: boolean
  owner_source: string
  owner_strategy: string
  company_size: string
  // deliverability
  email: string        // general inbox — never used for owner outreach
  email_status: string // Verifalia classification of owner_email
  email_verifalia_status: string
  mx_ok: boolean | null
  domain_catch_all: boolean | null
  pending_verify: boolean
  // verdict
  /**
   * v2's four-way verdict. `gate_passed` is v1's boolean, kept because rows
   * written before tiers existed still carry it and nothing has backfilled them.
   */
  tier: Tier | null
  gate_passed: boolean
  reject_reason: string
  /**
   * How the name was classified: `owner_grade`, `clinical_lead`, `staff`.
   * A clinical lead is only promoted when a second source agrees.
   */
  name_class: string | null
  /** Which sources independently agree on this person. */
  corroboration: string[] | null
  /** Trigram similarity of the registry match that named them, when there was one. */
  match_confidence: number | null
  step2_done: boolean
  owner_lookup_done: boolean
  created_at: string
}

/**
 * A pre-run census of the niche.
 *
 * The point of it is stated in HANDOFF §11: the benchmark niche contaminated
 * three phases of conclusions, and one crawl census predicts Tier A across
 * niches well enough to say so *before* spending the budget.
 */
export interface PreflightRun {
  id: string
  niche: string
  location: string
  sample_size: number
  status: string
  businesses_found: number
  businesses_with_site: number
  addresses_seen: number
  on_domain_addresses: number
  on_domain_personal: number
  businesses_with_personal: number
  named: number
  predicted_tier_a_low: number
  predicted_tier_a_high: number
  /** `strong` | `workable` | `poor` | `insufficient_data` */
  predicted_band: string
  estimated_cost_usd: number
  error: string | null
  created_at: string
  finished_at: string | null
}

export interface CampaignLog {
  id: number
  campaign_id: string
  step: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  created_at: string
}

/**
 * An operator-visible condition that must not degrade silently.
 *
 * `campaign_id` is null for fleet-wide conditions — a verifier out of credits
 * affects every run, not the one that happened to notice it first.
 */
export interface Alert {
  id: string
  campaign_id: string | null
  user_id: string | null
  kind: string
  severity: 'info' | 'warning' | 'error'
  message: string
  detail: Record<string, unknown>
  occurrences: number
  first_seen_at: string
  last_seen_at: string
  acknowledged_at: string | null
}
