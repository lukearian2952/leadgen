// The hard gate.
//
// A lead is exportable only if we can name a human, reach them at a mailbox
// Verifalia calls Deliverable, and show the business is the right type in the
// right place. This is a pure function over already-persisted columns so that
// finalize, the watchdog and the export all reach identical verdicts, and so a
// rejected row can be re-judged later without re-spending any API budget.

import {
  checkFirstName, isGenericLocalPart, isJunkDomain, isFreemail,
  freemailAllowed, emailDomain, extractDomain, isValidEmail,
} from './identity.ts'
import { checkInScope, checkDomainCountry, type LocationScope } from './geo.ts'
import { checkNicheTypes, type NicheFilter } from './niche-types.ts'

export interface GateLead {
  owner_first_name: string
  owner_last_name: string
  owner_email: string
  email: string
  website: string
  state: string
  country: string
  formatted_address: string
  place_types: string[] | null
  business_status: string
  mx_ok: boolean | null
  domain_catch_all: boolean | null
  email_status: string
  email_verifalia_status: string
  pending_verify: boolean
}

export interface GateContext {
  scope: LocationScope
  niche: NicheFilter
}

export interface GateVerdict {
  pass: boolean
  reason: string
}

const PASS: GateVerdict = { pass: true, reason: '' }
const fail = (reason: string): GateVerdict => ({ pass: false, reason })

/**
 * Checks run cheapest-and-most-explanatory first, so the reject_reason a user
 * sees names the real disqualifier rather than a downstream symptom. A business
 * in the wrong state should read `state_mismatch:MI`, not `no_owner_email`.
 */
export function evaluateGate(lead: GateLead, ctx: GateContext): GateVerdict {
  // ── The business itself ───────────────────────────────────────────────────

  if (lead.business_status && lead.business_status !== 'OPERATIONAL') {
    return fail(`business_${lead.business_status.toLowerCase()}`)
  }

  const scopeReason = checkInScope(
    { state: lead.state, country: lead.country, formattedAddress: lead.formatted_address },
    ctx.scope,
  )
  if (scopeReason) return fail(scopeReason)

  const typeReason = checkNicheTypes(lead.place_types ?? [], ctx.niche)
  if (typeReason) return fail(typeReason)

  // ── The domain ────────────────────────────────────────────────────────────

  if (!lead.website) return fail('no_website')

  const siteDomain = extractDomain(lead.website)
  if (!siteDomain) return fail('no_website')
  if (isJunkDomain(siteDomain)) return fail(`junk_domain:${siteDomain}`)

  const tldReason = checkDomainCountry(siteDomain, ctx.scope)
  if (tldReason) return fail(tldReason)

  // mx_ok === null means the lookup never succeeded. That is a "we don't know",
  // and rejecting on it would let a resolver outage silently empty an export —
  // so it fails the row without poisoning the reason.
  if (lead.mx_ok === false) return fail('no_mx')
  if (lead.mx_ok === null) return fail('mx_unknown')

  // ── The person ────────────────────────────────────────────────────────────

  const nameReason = checkFirstName(lead.owner_first_name)
  if (nameReason) return fail(nameReason)

  // ── The mailbox ───────────────────────────────────────────────────────────

  if (lead.pending_verify) return fail('pending_verify')

  const email = (lead.owner_email ?? '').trim()
  if (!email) return fail('no_owner_email')
  if (!isValidEmail(email)) return fail('owner_email_malformed')
  if (isGenericLocalPart(email)) return fail('owner_email_is_role_inbox')

  const mailDomain = emailDomain(email)
  if (isJunkDomain(mailDomain)) return fail(`junk_email_domain:${mailDomain}`)

  if (isFreemail(mailDomain) &&
      !freemailAllowed(email, lead.owner_first_name, lead.owner_last_name, siteDomain)) {
    return fail(`freemail:${mailDomain}`)
  }

  // Exactly Deliverable. Risky, Unknown and catch-all all fail — those three
  // are where the 6.4% bounce rate came from.
  if (lead.email_status !== 'deliverable') {
    return fail(`not_deliverable:${lead.email_status || 'unverified'}`)
  }
  if (lead.domain_catch_all === true) return fail('catch_all_domain')
  if (/catch.?all/i.test(lead.email_verifalia_status)) return fail('catch_all_domain')

  return PASS
}

/** Group reject reasons for reporting — `state_mismatch:MI` rolls up to `state_mismatch`. */
export function reasonFamily(reason: string): string {
  return (reason || 'unknown').split(':')[0]
}
