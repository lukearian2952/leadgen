export type CampaignStatus =
  | 'pending' | 'running' | 'paused' | 'completed' | 'failed'
  /** Finished, but under 25% of scraped businesses produced a mailable owner. */
  | 'completed_low_yield'

/** Terminal states where the campaign did its work. */
export const FINISHED_STATUSES: CampaignStatus[] = ['completed', 'completed_low_yield']

export function isFinished(status: CampaignStatus): boolean {
  return FINISHED_STATUSES.includes(status)
}

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
  // gate verdict
  gate_passed: boolean
  reject_reason: string
  step2_done: boolean
  owner_lookup_done: boolean
  created_at: string
}

export interface CampaignLog {
  id: number
  campaign_id: string
  step: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  created_at: string
}
