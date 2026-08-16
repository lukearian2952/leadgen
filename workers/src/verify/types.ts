// The verifier contract from brief §F.2.
//
// Two implementations sit behind it: `verify-svc` (our Go service wrapping
// AfterShip/email-verifier, running on our own IPs) and `verifalia` (the v1
// client, moved here unchanged as the safety net). The hybrid router in
// hybrid.ts decides which one sees a given address.

export type VerifyStatus = 'safe' | 'invalid' | 'risky' | 'unknown'

export interface VerifyResult {
  email: string
  status: VerifyStatus
  is_catch_all: boolean
  is_disposable: boolean
  is_role: boolean
  /** Which provider produced this verdict. */
  provider: string
  latency_ms: number
  cost_cents: number
  /** Present when the provider explained itself — SMTP banner, error text. */
  detail?: string
  /**
   * True when the provider could not run at all, as distinct from running and
   * reaching no conclusion.
   *
   * Both come back as `unknown`, and conflating them is what let a fleet-wide
   * outage look like a batch of inconclusive mailboxes. Only the first should
   * reroute the whole batch to the paid fallback; the second is a real verdict
   * and rerouting it wastes credits on addresses already judged.
   */
  unavailable?: boolean
}

export interface VerifierProvider {
  readonly name: string
  verify(emails: string[]): Promise<VerifyResult[]>
  /** False when the provider cannot run right now (no credentials, all IPs cooling). */
  available(): Promise<boolean>
}

/** Tier assignment from brief §F. */
export type Tier = 'A' | 'B' | 'C' | 'rejected'

export interface TierInput {
  status: VerifyStatus
  isCatchAll: boolean
  hasName: boolean
  hasDomain: boolean
  score: number
}

export const TIER_B_MIN_SCORE = 55

export function assignTier(input: TierInput): Tier {
  if (!input.hasName || !input.hasDomain) return 'rejected'
  if (input.status === 'safe' && !input.isCatchAll) return 'A'
  if (input.isCatchAll && input.score >= TIER_B_MIN_SCORE) return 'B'
  return 'C'
}

/**
 * Confidence score for a catch-all candidate, per the brief's weights.
 *
 * These decide Tier B, which is the bucket that recovers the 52% of *named*
 * leads v1 threw away on catch-all domains. Deliberately additive and capped
 * nowhere — a lead corroborated by registry, pattern and LinkedIn should score
 * far above the threshold, not sit exactly on it.
 */
export interface ScoreSignals {
  nameFromRegistryOrLinkedIn: boolean
  nameFromSiteWithOwnerTitle: boolean
  patternMatchesKnownDomainPattern: boolean
  emailSeenOnSiteOrMailto: boolean
  linkedInProfileLinksToDomain: boolean
}

export function scoreCandidate(signals: ScoreSignals): number {
  let score = 0
  if (signals.nameFromRegistryOrLinkedIn) score += 40
  if (signals.nameFromSiteWithOwnerTitle) score += 25
  if (signals.patternMatchesKnownDomainPattern) score += 20
  if (signals.emailSeenOnSiteOrMailto) score += 10
  if (signals.linkedInProfileLinksToDomain) score += 10
  return score
}
