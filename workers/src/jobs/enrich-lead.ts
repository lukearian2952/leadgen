// enrich:lead — turn a name into candidate mailboxes, then verify.
//
// Order matters and is entirely about cost:
//   1. MX first. No MX means no mailbox can exist, so nothing downstream runs.
//   2. An address already seen on the site needs no guess — verify it directly.
//   3. A learned domain pattern collapses six guesses to one.
//   4. Only then fall back to the full candidate ladder.
//
// Verification goes through the hybrid router, so verify-svc sees everything
// and Verifalia only sees unknown/risky verdicts on high-trust names.

import type { Task } from 'graphile-worker'
import { wrapTask } from './wrap.js'
import type { TaskDeps } from './index.js'
import { buildVerifier } from './verify-batch.js'
import type { Candidate } from '../verify/hybrid.js'
import { assignTier, scoreCandidate, type VerifyResult } from '../verify/types.js'
import { candidatesFor, foldPattern, inferPattern, type PatternName, type PatternRecord } from '../lib/patterns.js'
import {
  extractDomain, isJunkDomain, isFreemail, freemailAllowed,
  isGenericLocalPart, checkFirstName, emailDomain, isValidEmail,
} from '../lib/identity.js'
import {
  freemailBusinessVerified, FREEMAIL_TIER_REASON,
} from '../lib/freemail.js'
import { hasMx } from '../lib/dns.js'

interface Payload { campaignId: string; leadId: string; [key: string]: unknown }

interface LeadRow {
  id: string
  business_id: string | null
  business_name: string
  website: string
  owner_first_name: string
  owner_last_name: string
  owner_source: string
  name_class: string
  corroboration: string[] | null
  title: string
  email: string
  evidence: Record<string, unknown>
}

export function makeEnrichLeadTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'enrich:lead', db }, async (payload, ctx) => {
    const { campaignId, leadId } = payload

    const { rows } = await db.query<LeadRow>(
      `select id, business_id, business_name, website, owner_first_name, owner_last_name,
              owner_source, name_class, corroboration, title, email, evidence
         from leads where id = $1`, [leadId])
    const lead = rows[0]
    if (!lead) { ctx.logger.warn('lead vanished'); return }

    const finish = async (tier: string, reason: string, extra: Record<string, unknown> = {}) => {
      await db.query(
        `update leads set enrich_done = true, tier = $2, reject_reason = $3,
                          evidence = evidence || $4::jsonb where id = $1`,
        [leadId, tier, reason, JSON.stringify(extra)])
      ctx.cost.detail = { ...ctx.cost.detail, tier, reason, ...extra }
    }

    const domain = extractDomain(lead.website)
    if (!domain || isJunkDomain(domain)) return finish('rejected', domain ? 'junk_domain' : 'no_website')

    const nameReason = checkFirstName(lead.owner_first_name)
    const hasName = !nameReason

    // Addresses the business itself published — scraped from its own site or
    // read off its Google listing. These are the only ones the freemail path
    // will ever consider; a *generated* gmail guess is someone else's mailbox
    // and it will deliver.
    const published = await publishedAddresses(db, campaignId, leadId, lead)

    const highTrust = ['registry', 'linkedin', 'serp'].some(s => lead.owner_source.includes(s))

    /**
     * The Phase 3 freemail path, for a business whose own domain cannot carry
     * mail. Verifies the published consumer addresses and admits at most one,
     * at Tier B, under lib/freemail.ts's four conditions.
     */
    const tryPublishedFreemail = async (
      mxReason: string, addresses: string[],
    ): Promise<void> => {
      const freemails = addresses.filter(e => isFreemail(emailDomain(e)))
      if (!freemails.length) return finish('rejected', mxReason)

      const verifier = buildVerifier(config, db, ctx.logger, campaignId)
      const outcome = await verifier.verify(
        campaignId, freemails.map(email => ({ email, highTrustName: highTrust })))
      ctx.cost.cents = outcome.stats.spendCents

      let rejectReason = `${mxReason}:freemail_none_admissible`
      for (const result of outcome.results) {
        const verdict = freemailBusinessVerified({
          email: result.email,
          businessName: lead.business_name,
          ownerFirst: lead.owner_first_name,
          ownerLast: lead.owner_last_name,
          publishedAddresses: addresses,
          status: result.status,
          isCatchAll: result.is_catch_all,
        })
        if (!verdict.accepted) { rejectReason = verdict.reason; continue }

        // Tier B by construction. The policy is explicit that this route never
        // reaches Tier A: the address is right, but it is a consumer mailbox
        // the business chose rather than a mailbox on a domain it controls.
        const score = scoreCandidate({
          nameFromRegistryOrLinkedIn: highTrust,
          nameFromSiteWithOwnerTitle: lead.owner_source === 'site_crawl' && Boolean(lead.title),
          patternMatchesKnownDomainPattern: false,
          emailSeenOnSiteOrMailto: true,
          linkedInProfileLinksToDomain: false,
        })

        await writeContact(db, campaignId, lead, result, 'B', score,
          '', FREEMAIL_TIER_REASON, [lead.owner_source || 'site_crawl'], {
            freemail_matched_token: verdict.matchedToken ?? null,
            mx_status: mxReason,
            published_addresses: addresses,
          })

        await db.query(
          `update leads
              set enrich_done = true, tier = 'B', score = $2, reject_reason = '',
                  tier_reason = $3, owner_email = $4, email_status = $5,
                  evidence = evidence || $6::jsonb
            where id = $1`,
          [leadId, score, FREEMAIL_TIER_REASON, result.email, result.status,
           JSON.stringify({
             freemail_tier_b: {
               email: result.email, matched_token: verdict.matchedToken ?? null,
               mx_status: mxReason, provider: result.provider,
             },
           })])

        ctx.cost.detail = {
          tier: 'B', tier_reason: FREEMAIL_TIER_REASON, score,
          status: result.status, mx_status: mxReason,
          verifalia_checks: outcome.stats.verifaliaChecks,
          verify_svc_checks: outcome.stats.verifySvcChecks,
        }
        return
      }

      return finish('rejected', rejectReason, {
        freemail_considered: freemails,
        verifalia_checks: outcome.stats.verifaliaChecks,
      })
    }

    // ── MX ────────────────────────────────────────────────────────────────────
    //
    // A domain with no MX cannot carry mail, and Phase 2 stopped there — which
    // is where 22 of 75 leads died, 8 of them while publishing a working Gmail
    // on their own homepage. Those are site-builder domains (glossgenius.com,
    // square.site) where the business genuinely runs its mail on a consumer
    // provider. So a missing MX is no longer the end of the row: it routes to
    // the published-freemail path, which is Tier B at best and rejects on any
    // of its four conditions failing.
    const mxOk = await hasMx(domain)
    await db.query(`update leads set mx_ok = $2 where id = $1`, [leadId, mxOk])
    if (mxOk !== true) {
      if (!hasName) return finish('rejected', nameReason!)
      return tryPublishedFreemail(
        mxOk === false ? 'no_mx' : 'mx_unknown', published)
    }

    if (!hasName) return finish('rejected', nameReason!)

    // ── candidates ────────────────────────────────────────────────────────────
    const known = await loadPattern(db, domain)

    // An address the site itself published beats any generated guess.
    const { rows: existing } = await db.query<{ email: string }>(
      `select email from contacts where campaign_id = $1 and lead_id = $2 and email <> ''`,
      [campaignId, leadId])
    const siteEmail = existing[0]?.email ?? ''

    const generated = candidatesFor(
      lead.owner_first_name, lead.owner_last_name, domain, known?.pattern, 6)

    const toCheck = [...new Set([siteEmail, ...generated].filter(Boolean))]
      .filter(e => !isGenericLocalPart(e))
    if (!toCheck.length) return finish('rejected', 'no_candidate_addresses')

    // ── verify ────────────────────────────────────────────────────────────────
    // High trust = registry, LinkedIn or SERP — the sources that corroborate a
    // name from outside the business's own marketing copy. Phase 2 had none of
    // them, so nothing earned a paid Verifalia second opinion and the budget
    // went untouched. Phase 3 has two, so it starts being spent.
    const candidates: Candidate[] = toCheck.map(email => ({ email, highTrustName: highTrust }))

    const verifier = buildVerifier(config, db, ctx.logger, campaignId)
    const outcome = await verifier.verify(campaignId, candidates)
    const byEmail = new Map(outcome.results.map(r => [r.email, r]))

    // First `safe` wins; otherwise keep the best verdict for an honest reason.
    let chosen: VerifyResult | undefined
    for (const email of toCheck) {
      const r = byEmail.get(email)
      if (r && r.status === 'safe' && !r.is_catch_all) { chosen = r; break }
    }
    const catchAll = outcome.results.some(r => r.is_catch_all)
    if (!chosen) {
      chosen = outcome.results.find(r => r.is_catch_all)
            ?? outcome.results.find(r => r.status === 'risky')
            ?? outcome.results.find(r => r.status === 'unknown')
            ?? outcome.results[0]
    }

    if (!chosen) return finish('rejected', 'no_verdict')

    // Freemail. v1's narrow rule first — an owner-named mailbox at a business
    // that runs entirely on a consumer provider. Failing that, the Phase 3
    // path, which admits a *published, business-named* address at Tier B only.
    const mailDomain = emailDomain(chosen.email)
    let freemailTierB = false
    let freemailToken: string | undefined

    if (isFreemail(mailDomain) &&
        !freemailAllowed(chosen.email, lead.owner_first_name, lead.owner_last_name, domain)) {
      const verdict = freemailBusinessVerified({
        email: chosen.email,
        businessName: lead.business_name,
        ownerFirst: lead.owner_first_name,
        ownerLast: lead.owner_last_name,
        publishedAddresses: published,
        status: chosen.status,
        isCatchAll: chosen.is_catch_all || catchAll,
      })
      if (!verdict.accepted) return finish('rejected', `freemail:${mailDomain}`, {
        freemail_reject: verdict.reason,
      })
      freemailTierB = true
      freemailToken = verdict.matchedToken
    }

    // ── score + tier ──────────────────────────────────────────────────────────
    const score = scoreCandidate({
      nameFromRegistryOrLinkedIn: highTrust,
      nameFromSiteWithOwnerTitle: lead.owner_source === 'site_crawl' && Boolean(lead.title),
      patternMatchesKnownDomainPattern:
        Boolean(known && inferPattern(chosen.email, lead.owner_first_name, lead.owner_last_name) === known.pattern),
      emailSeenOnSiteOrMailto: chosen.email === siteEmail,
      linkedInProfileLinksToDomain: false,
    })

    // Domain-level catch-all counts as catch-all for this address, because the
    // server accepting anything is a property of the domain, not the mailbox.
    const isCatchAll = chosen.is_catch_all || catchAll

    const naturalTier = assignTier({
      status: chosen.status,
      isCatchAll,
      hasName: true,
      hasDomain: true,
      score,
    })

    // The freemail path is capped at Tier B by policy, never Tier A. A
    // published consumer mailbox verifying `safe` would otherwise land in the
    // main CSV, and the whole point of the concession is that it does not.
    const tier = freemailTierB ? (naturalTier === 'rejected' ? 'rejected' : 'B') : naturalTier

    // The reason has to be derived from the same `isCatchAll` the tier used.
    // Testing `chosen.is_catch_all` alone produced `not_deliverable:safe` — a
    // deliverable address on a domain-level catch-all, correctly held out of
    // Tier A but labelled as though the mailbox had failed.
    const rejectReason = tier === 'A' ? ''
      : freemailTierB ? ''
      : tier === 'B' ? `catch_all_scored:${score}`
      : chosen.status === 'invalid' ? 'mailbox_invalid'
      : isCatchAll ? `catch_all_low_score:${score}`
      : `not_deliverable:${chosen.status}`

    const tierReason = freemailTierB ? FREEMAIL_TIER_REASON
      : tier === 'B' ? `catch_all_scored:${score}`
      : ''

    await writeContact(db, campaignId, lead, chosen, tier, score,
      rejectReason, tierReason, [lead.owner_source || 'site_crawl'], {
        candidates_tried: toCheck,
        pattern_used: known?.pattern ?? null,
        verifier_detail: chosen.detail,
        owner_title: lead.title,
        freemail_matched_token: freemailToken ?? null,
      })

    await db.query(
      `update leads
          set enrich_done = true, tier = $2, score = $3, reject_reason = $4,
              owner_email = $5, email_status = $6, domain_catch_all = $7,
              tier_reason = $9,
              evidence = evidence || $8::jsonb
        where id = $1`,
      [leadId, tier, score, rejectReason,
       tier === 'A' || tier === 'B' ? chosen.email : '',
       chosen.status, chosen.is_catch_all || catchAll,
       JSON.stringify({
         verified: { email: chosen.email, status: chosen.status, provider: chosen.provider,
                     catch_all: chosen.is_catch_all, detail: chosen.detail },
         candidates_tried: toCheck,
         pattern_used: known?.pattern ?? null,
         score_signals: { high_trust: highTrust, site_title: Boolean(lead.title),
                          seen_on_site: chosen.email === siteEmail },
       }), tierReason])

    // A confirmed-good address teaches this domain's pattern for every future
    // lead on it. This is the compounding asset in the whole design.
    if (chosen.status === 'safe' && !chosen.is_catch_all) {
      await savePattern(db, known, chosen.email, lead.owner_first_name, lead.owner_last_name)
    }
    if (catchAll) await markCatchAll(db, domain)

    ctx.cost.cents = outcome.stats.spendCents
    ctx.cost.detail = {
      tier, score, status: chosen.status, catch_all: chosen.is_catch_all,
      tier_reason: tierReason || undefined,
      name_class: lead.name_class || undefined,
      corroboration: lead.corroboration ?? [],
      candidates: toCheck.length,
      verify_svc_checks: outcome.stats.verifySvcChecks,
      verifalia_checks: outcome.stats.verifaliaChecks,
      both_ran: outcome.stats.bothRan, agreed: outcome.stats.agreed,
      pattern_used: known?.pattern ?? null,
    }
  })
}

/**
 * Addresses the business itself published — from its own site (recorded as a
 * contact by crawl:site) and from its Google listing (gosom's `emails` column,
 * kept in the lead's evidence).
 *
 * The freemail path checks membership of this set, so it must never contain a
 * generated candidate. Everything here was read off something the business
 * controls.
 */
async function publishedAddresses(
  db: TaskDeps['db'], campaignId: string, leadId: string, lead: LeadRow,
): Promise<string[]> {
  const out = new Set<string>()

  const { rows } = await db.query<{ email: string }>(
    `select email from contacts
      where campaign_id = $1 and lead_id = $2 and email <> ''
        and 'site_crawl' = any(sources)`, [campaignId, leadId])
  for (const r of rows) out.add(r.email.toLowerCase())

  // crawl:site writes the best general/personal inbox it found to leads.email.
  if (lead.email && isValidEmail(lead.email)) out.add(lead.email.toLowerCase())

  const mapsEmails = (lead.evidence?.maps_emails as string[] | undefined) ?? []
  for (const e of mapsEmails) if (isValidEmail(e)) out.add(e.toLowerCase())

  const crawlEmails = (lead.evidence?.crawl_emails as string[] | undefined) ?? []
  for (const e of crawlEmails) if (isValidEmail(e)) out.add(e.toLowerCase())

  return [...out]
}

/** One place that writes a `contacts` row, so both tier paths agree on shape. */
async function writeContact(
  db: TaskDeps['db'], campaignId: string, lead: LeadRow, result: VerifyResult,
  tier: string, score: number, rejectReason: string, tierReason: string,
  sources: string[], evidence: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into contacts
       (campaign_id, lead_id, business_id, email, email_kind, status, is_catch_all,
        is_role, is_disposable, provider, tier, score, reject_reason, tier_reason,
        name_class, corroboration, sources, evidence, verified_at)
     values ($1,$2,$3,$4,'owner',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16,$17,now())
     on conflict (campaign_id, email) where email <> '' do update
       set status = excluded.status, tier = excluded.tier, score = excluded.score,
           is_catch_all = excluded.is_catch_all, provider = excluded.provider,
           reject_reason = excluded.reject_reason, tier_reason = excluded.tier_reason,
           name_class = excluded.name_class, corroboration = excluded.corroboration,
           verified_at = now()`,
    [campaignId, lead.id, lead.business_id, result.email, result.status,
     result.is_catch_all, result.is_role, result.is_disposable, result.provider,
     tier, score, rejectReason, tierReason,
     lead.name_class, lead.corroboration ?? [], sources,
     JSON.stringify(evidence)])
}

async function loadPattern(db: TaskDeps['db'], domain: string): Promise<PatternRecord | null> {
  const { rows } = await db.query<{ domain: string; pattern: string; confidence: string; samples: number }>(
    `select domain, pattern, confidence, samples from domain_patterns where domain = $1`, [domain])
  if (!rows[0]) return null
  return {
    domain: rows[0].domain,
    pattern: rows[0].pattern as PatternName,
    confidence: Number(rows[0].confidence),
    samples: rows[0].samples,
  }
}

async function savePattern(
  db: TaskDeps['db'], existing: PatternRecord | null,
  email: string, first: string, last: string,
) {
  const folded = foldPattern(existing, email, first, last)
  if (!folded) return
  await db.query(
    `insert into domain_patterns (domain, pattern, confidence, samples, learned_from, updated_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (domain) do update
       set pattern = excluded.pattern, confidence = excluded.confidence,
           samples = excluded.samples, updated_at = now()`,
    [folded.domain, folded.pattern, folded.confidence, folded.samples, email])
}

async function markCatchAll(db: TaskDeps['db'], domain: string) {
  await db.query(
    `insert into domain_patterns (domain, pattern, confidence, catch_all, catch_all_checked_at)
     values ($1,'first',0.1,true,now())
     on conflict (domain) do update
       set catch_all = true, catch_all_checked_at = now()`,
    [domain])
}
