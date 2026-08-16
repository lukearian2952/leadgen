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
  isGenericLocalPart, checkFirstName, emailDomain,
} from '../lib/identity.js'
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
              owner_source, title, email, evidence
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

    // ── MX ────────────────────────────────────────────────────────────────────
    const mxOk = await hasMx(domain)
    await db.query(`update leads set mx_ok = $2 where id = $1`, [leadId, mxOk])
    if (mxOk === false) return finish('rejected', 'no_mx')
    if (mxOk === null) return finish('rejected', 'mx_unknown')

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
    // High trust = registry or LinkedIn. In Phase 2 neither source exists yet,
    // so nothing earns a paid Verifalia second opinion and the budget stays
    // untouched — deliberately, not accidentally.
    const highTrust = ['registry', 'linkedin'].some(s => lead.owner_source.includes(s))
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

    // Freemail survives only under the narrow rule.
    const mailDomain = emailDomain(chosen.email)
    if (isFreemail(mailDomain) &&
        !freemailAllowed(chosen.email, lead.owner_first_name, lead.owner_last_name, domain)) {
      return finish('rejected', `freemail:${mailDomain}`)
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

    const tier = assignTier({
      status: chosen.status,
      isCatchAll: chosen.is_catch_all || catchAll,
      hasName: true,
      hasDomain: true,
      score,
    })

    const rejectReason = tier === 'A' ? ''
      : tier === 'B' ? `catch_all_scored:${score}`
      : chosen.status === 'invalid' ? 'mailbox_invalid'
      : chosen.is_catch_all ? `catch_all_low_score:${score}`
      : `not_deliverable:${chosen.status}`

    await db.query(
      `insert into contacts
         (campaign_id, lead_id, business_id, email, email_kind, status, is_catch_all,
          is_role, is_disposable, provider, tier, score, reject_reason, sources, evidence, verified_at)
       values ($1,$2,$3,$4,'owner',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       on conflict (campaign_id, email) where email <> '' do update
         set status = excluded.status, tier = excluded.tier, score = excluded.score,
             is_catch_all = excluded.is_catch_all, provider = excluded.provider,
             reject_reason = excluded.reject_reason, verified_at = now()`,
      [campaignId, leadId, lead.business_id, chosen.email, chosen.status,
       chosen.is_catch_all, chosen.is_role, chosen.is_disposable, chosen.provider,
       tier, score, rejectReason,
       [lead.owner_source || 'site_crawl'],
       JSON.stringify({
         candidates_tried: toCheck,
         pattern_used: known?.pattern ?? null,
         verifier_detail: chosen.detail,
         owner_title: lead.title,
       })])

    await db.query(
      `update leads
          set enrich_done = true, tier = $2, score = $3, reject_reason = $4,
              owner_email = $5, email_status = $6, domain_catch_all = $7,
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
       })])

    // A confirmed-good address teaches this domain's pattern for every future
    // lead on it. This is the compounding asset in the whole design.
    if (chosen.status === 'safe' && !chosen.is_catch_all) {
      await savePattern(db, known, chosen.email, lead.owner_first_name, lead.owner_last_name)
    }
    if (catchAll) await markCatchAll(db, domain)

    ctx.cost.cents = outcome.stats.spendCents
    ctx.cost.detail = {
      tier, score, status: chosen.status, catch_all: chosen.is_catch_all,
      candidates: toCheck.length,
      verify_svc_checks: outcome.stats.verifySvcChecks,
      verifalia_checks: outcome.stats.verifaliaChecks,
      both_ran: outcome.stats.bothRan, agreed: outcome.stats.agreed,
      pattern_used: known?.pattern ?? null,
    }
  })
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
