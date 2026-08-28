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
import { wrapTask, type JobContext } from './wrap.js'
import type { TaskDeps } from './index.js'
import { buildVerifier } from './verify-batch.js'
import { makeMailboxProvider, type MailboxProvider } from '../sources/mailbox-provider.js'
import type { Candidate } from '../verify/hybrid.js'
import { assignTier, scoreCandidate, type VerifyResult } from '../verify/types.js'
import {
  candidateLadder, followsAcceptedShape, foldPattern, inferPattern,
  type PatternName, type PatternRecord,
} from '../lib/patterns.js'
import {
  discoverPattern, domainHasPublishedMailbox, addressQuery, addressesFromText,
  type DiscoveryResult, type PatternSource,
} from '../lib/pattern-discovery.js'
import { makeSerpProvider } from '../sources/serp-provider.js'
import { SerpSource } from '../sources/serp.js'
import type { NameCandidate } from '../lib/name-decision.js'
import {
  extractDomain, isJunkDomain, isFreemail, freemailAllowed,
  isGenericLocalPart, checkFirstName, emailDomain, isValidEmail,
} from '../lib/identity.js'
import {
  freemailBusinessVerified, FREEMAIL_TIER_REASON, CATCH_ALL_TIER_REASON,
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

/**
 * How many public pages a provider must have seen an address on before we
 * believe it. Zero would admit the provider's guesses alongside our own.
 */
const PROVIDER_MIN_SOURCES = 1

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

    // ── pattern discovery ─────────────────────────────────────────────────────
    //
    // Learn the domain's convention *before* guessing at it. Phase 3 only ever
    // learned a pattern from a successful verified send, which is circular —
    // a domain had to convert before it could teach anything, so
    // `domain_patterns` stayed nearly empty and every lead paid for six
    // guesses. A single personal address already printed on the site collapses
    // that to one.
    const stored = await loadPattern(db, domain)
    const discovery = await discoverDomainPattern(
      db, config, ctx, campaignId, leadId, lead, domain)

    // A stored pattern from a verified send outranks a freshly inferred one:
    // it was confirmed by a mailbox actually existing, not by a string match.
    const known: PatternRecord | null =
      stored?.source === 'verified_send' ? stored
      : discovery.discovered
        ? { domain, pattern: discovery.discovered.pattern, confidence: 0.7, samples: 1 }
        : stored

    if (discovery.discovered && stored?.source !== 'verified_send') {
      await saveDiscoveredPattern(db, domain, discovery)
    }

    // An address the site itself published beats any generated guess.
    const { rows: existing } = await db.query<{ email: string }>(
      `select email from contacts where campaign_id = $1 and lead_id = $2 and email <> ''`,
      [campaignId, leadId])
    const siteEmail = existing[0]?.email ?? ''

    // Learned pattern first, then the standard six, then the four extras. The
    // extras are **off by default**: measured on the benchmark they recovered
    // zero mailboxes for 2.6x the verification spend, so the ladder is the
    // standard six unless PATTERN_LADDER_EXTRAS says otherwise.
    const generated = candidateLadder(
      lead.owner_first_name, lead.owner_last_name, domain, known?.pattern,
      config.patternLadderExtras)

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

    const deliverable = (rs: readonly VerifyResult[], order: readonly string[]) => {
      for (const email of order) {
        const r = rs.find(x => x.email === email)
        if (r && r.status === 'safe' && !r.is_catch_all) return r
      }
      return undefined
    }

    // ── provider lookup ───────────────────────────────────────────────────────
    //
    // Bought only now, and only because the free sources and the whole pattern
    // ladder produced nothing deliverable. This is the state 176 businesses —
    // 12.5% of everything processed — end in, and 205 of 209 of them have no
    // mailbox at all rather than one that failed, so the ladder is exhausted
    // rather than unlucky.
    //
    // The address it returns is appended to the candidate set and verified
    // through the same router. It does not bypass the gate and its own
    // `verification.status` is recorded, never trusted — Hunter will happily
    // return an address with `sources: 0`, which is a guess with better
    // branding than ours.
    let providerLookup: Awaited<ReturnType<MailboxProvider['find']>> = null
    let providerName: string | null = null

    if (!deliverable(outcome.results, toCheck)) {
      const provider = makeMailboxProvider(config, ctx.logger)
      if (provider && lead.owner_first_name && lead.owner_last_name) {
        const { rows: [spent] } = await db.query<{ units: number }>(
          `select coalesce(sum(units),0)::int units from source_costs
            where campaign_id = $1 and source = 'provider_lookup'`, [campaignId])

        if ((spent?.units ?? 0) >= config.hunterMaxLookupsPerCampaign) {
          ctx.logger.warn('provider lookup cap reached for this campaign', {
            campaignId, cap: config.hunterMaxLookupsPerCampaign, spent: spent?.units,
          })
        } else {
          providerName = provider.name
          try {
            providerLookup = await provider.find(
              domain, lead.owner_first_name, lead.owner_last_name)
          } catch (err) {
            ctx.logger.warn('provider lookup threw', { err: (err as Error).message })
          }

          // Metered whether or not it found anything: a lookup that returns
          // nothing still costs a request, and the hit rate is the number this
          // whole component is judged on.
          await db.query(
            `select add_source_cost($1,$2,$3,$4,$5,$6,$7,$8)`,
            [campaignId, 'provider_lookup', `provider:${provider.name}`, 1, 0, 0, 0,
             provider.centsPerLookup])
          ctx.cost.cents += provider.centsPerLookup

          // ── the sources gate ──────────────────────────────────────────────
          //
          // Measured before this line existed. Over 189 Tier C leads Hunter
          // returned an address for 46 (24.3%), but only **13 of those 46 had
          // `sources > 0`** — had actually been seen on a public page. The
          // other 33 were inferred from the domain's pattern, which is the
          // same thing `candidateLadder` does, and the ladder has already
          // tried them by the time we get here.
          //
          // End-to-end on 60 Tier C leads the provider's address won twice.
          // One was `jamiefrew@carepatron.com` — `sources: 30`, not
          // catch-all, verified deliverable, and a local part no ladder would
          // ever generate. The other was inferred, on a catch-all domain, and
          // reached Tier B on the concession rather than on evidence.
          //
          // That is the whole value and the whole risk in one comparison. An
          // inferred address on a catch-all domain manufactures a Tier B row
          // that looks like evidence and is a guess — the failure mode the
          // 6.4% bounce rate taught. An observed address is a fact we did not
          // have. So only observed addresses are admitted.
          const found = providerLookup?.email
          const observed = (providerLookup?.sources ?? 0) >= PROVIDER_MIN_SOURCES

          if (found && !observed) {
            ctx.logger.info('provider address ignored — inferred, not observed', {
              email: found, sources: providerLookup?.sources ?? 0,
            })
          }

          if (found && observed && !toCheck.includes(found) && !isGenericLocalPart(found)) {
            const extra = await verifier.verify(
              campaignId, [{ email: found, highTrustName: highTrust }])
            outcome.results.push(...extra.results)
            outcome.stats.verifaliaChecks += extra.stats.verifaliaChecks
            outcome.stats.verifySvcChecks += extra.stats.verifySvcChecks
            outcome.stats.spendCents += extra.stats.spendCents
            toCheck.push(found)
          }
        }
      }
    }

    const byEmail = new Map(outcome.results.map(r => [r.email, r]))

    // First `safe` wins; otherwise keep the best verdict for an honest reason.
    let chosen: VerifyResult | undefined = deliverable(outcome.results, toCheck)
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

    // ── catch_all_named ───────────────────────────────────────────────────────
    //
    // Phase 3 lost 6 of 30 named leads to `catch_all_low_score`. The score gate
    // was the wrong instrument: a catch-all domain accepts every address, so no
    // amount of probing distinguishes a real mailbox from a guess, and the
    // score was standing in for evidence it never had.
    //
    // Two pieces of real evidence replace it, and both must hold:
    //
    //   1. **The domain demonstrably receives mail** — it publishes an address
    //      on itself, on its own site or its Google listing. A role inbox
    //      counts: `info@theclinic.com` on the contact page is the business
    //      saying mail sent here reaches us. That is what separates a working
    //      catch-all from a parked domain, and it is better evidence than an
    //      SMTP handshake that would have succeeded either way.
    //   2. **The address is a shape a human would have been given** — the
    //      domain's learned pattern, or `first@` / `first.last@`. A rare
    //      corporate shape guessed onto a catch-all is manufactured confidence.
    //
    // The score is still computed and recorded, it just no longer gates. The
    // result is Tier B with a distinct label so the sender can segment it away
    // from the freemail bucket.
    const shape = followsAcceptedShape(
      chosen.email, lead.owner_first_name, lead.owner_last_name, known?.pattern)
    const domainReceivesMail = domainHasPublishedMailbox(discovery)
    const catchAllNamed = isCatchAll && !freemailTierB &&
      chosen.status !== 'invalid' && domainReceivesMail && shape.ok

    // Both concessions cap at Tier B, never Tier A. Neither has proof that this
    // specific mailbox exists — only that it is the right shape on a domain
    // that reads its mail.
    const tier = naturalTier === 'rejected' ? 'rejected'
      : freemailTierB ? 'B'
      : catchAllNamed ? 'B'
      : naturalTier

    // The reason has to be derived from the same `isCatchAll` the tier used.
    // Testing `chosen.is_catch_all` alone produced `not_deliverable:safe` — a
    // deliverable address on a domain-level catch-all, correctly held out of
    // Tier A but labelled as though the mailbox had failed.
    const rejectReason = tier === 'A' ? ''
      : freemailTierB || catchAllNamed ? ''
      : tier === 'B' ? `catch_all_scored:${score}`
      : chosen.status === 'invalid' ? 'mailbox_invalid'
      : isCatchAll ? `catch_all_low_score:${score}`
      : `not_deliverable:${chosen.status}`

    const tierReason = freemailTierB ? FREEMAIL_TIER_REASON
      : catchAllNamed ? CATCH_ALL_TIER_REASON
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
      // The provider's hit rate is the number the whole component is judged on,
      // so record the miss as explicitly as the hit: `provider` set with
      // `provider_email` null is a lookup that was bought and returned nothing.
      provider: providerName,
      provider_email: providerLookup?.email ?? null,
      provider_score: providerLookup?.score ?? null,
      provider_sources: providerLookup?.sources ?? null,
      provider_observed: providerLookup
        ? (providerLookup.sources ?? 0) >= PROVIDER_MIN_SOURCES : null,
      // Their verdict beside ours, on the same address. Recorded so the two can
      // be compared later; ours is the one that gates.
      provider_status: providerLookup?.providerStatus ?? null,
      provider_won: Boolean(providerLookup?.email && chosen.email === providerLookup.email),
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

/** Stored pattern, plus how it was learned — a verified send outranks inference. */
type StoredPattern = PatternRecord & { source: string }

async function loadPattern(db: TaskDeps['db'], domain: string): Promise<StoredPattern | null> {
  const { rows } = await db.query<{
    domain: string; pattern: string; confidence: string; samples: number; source: string
  }>(
    `select domain, pattern, confidence, samples, source
       from domain_patterns where domain = $1`, [domain])
  if (!rows[0]) return null
  return {
    domain: rows[0].domain,
    pattern: rows[0].pattern as PatternName,
    confidence: Number(rows[0].confidence),
    samples: rows[0].samples,
    source: rows[0].source ?? '',
  }
}

/**
 * Everything this domain has published, and what convention it implies.
 *
 * Four sources, in cost order. The first three are already paid for — the
 * crawl ran, the mailto links were scraped, the Google listing came with the
 * Maps row. Only the SERP query costs anything, and it runs only when the free
 * sources found no personal address, since that is the only case where it can
 * change the answer.
 */
async function discoverDomainPattern(
  db: TaskDeps['db'], config: TaskDeps['config'], ctx: JobContext,
  campaignId: string, leadId: string, lead: LeadRow, domain: string,
): Promise<DiscoveryResult> {
  const addresses: Array<{ email: string; source: PatternSource }> = []
  const add = (list: unknown, source: PatternSource) => {
    for (const e of (list as string[] | undefined) ?? []) {
      if (typeof e === 'string') addresses.push({ email: e, source })
    }
  }

  add(lead.evidence?.crawl_emails, 'site_crawl')
  add(lead.evidence?.maps_emails, 'gbp')
  if (lead.email) addresses.push({ email: lead.email, source: 'mailto' })

  const { rows: contactRows } = await db.query<{ email: string }>(
    `select email from contacts where campaign_id = $1 and lead_id = $2 and email <> ''`,
    [campaignId, leadId])
  for (const r of contactRows) addresses.push({ email: r.email, source: 'site_crawl' })

  // Everyone the crawl named, whatever their title. A receptionist's address
  // teaches the domain's convention exactly as well as the owner's.
  const people = ((lead.evidence?.name_candidates as NameCandidate[] | undefined) ?? [])
    .filter(c => c.first)
    .map(c => ({ first: c.first, last: c.last }))

  let result = discoverPattern({ domain, addresses, people })

  // One SERP query, only when the free sources came up empty and there is
  // someone to attribute an address to.
  const addressProvider =
    !result.discovered && people.length ? makeSerpProvider(config, ctx.logger) : null
  if (addressProvider) {
    try {
      const serp = new SerpSource(addressProvider, db, ctx.logger)
      const { results, cached, bytes } = await serp.search(addressQuery(domain), 8)
      const found = new Set<string>()
      for (const r of results) {
        for (const e of addressesFromText(`${r.title} ${r.content} ${r.url}`, domain)) found.add(e)
      }
      if (found.size) {
        for (const email of found) addresses.push({ email, source: 'serp' })
        result = discoverPattern({ domain, addresses, people })
      }
      // This stage's one SERP query is metered like serp:owner's, so the
      // campaign's query count is the real total rather than serp:owner's share.
      if (!cached) {
        await db.query(`select add_source_cost($1,$2,$3,$4,$5,$6,$7,$8)`,
          [campaignId, 'serp_queries', `serp:${addressProvider.name}`, 1, bytes, 0, 0,
           addressProvider.centsPerQuery])
      }
      ctx.cost.detail = {
        ...ctx.cost.detail, address_serp_cached: cached,
        address_serp_found: found.size, address_serp_bytes: bytes,
      }
    } catch (err) {
      // A SERP outage must not fail the lead — it just means no extra address.
      ctx.logger.warn('address discovery serp failed', { domain, err: (err as Error).message })
    }
  }

  return result
}

/**
 * Record an inferred pattern.
 *
 * Confidence 0.7, below the 0.85+ a repeatedly-confirmed send earns: this was
 * read off a string that matched a name, which is good evidence and not proof.
 * `source` keeps the two distinguishable so a verified send can always
 * overrule.
 */
async function saveDiscoveredPattern(
  db: TaskDeps['db'], domain: string, discovery: DiscoveryResult,
): Promise<void> {
  const d = discovery.discovered
  if (!d) return
  await db.query(
    `insert into domain_patterns
       (domain, pattern, confidence, samples, learned_from, source, discovered_addresses, updated_at)
     values ($1,$2,0.7,1,$3,$4,$5,now())
     on conflict (domain) do update
       set pattern = excluded.pattern, confidence = excluded.confidence,
           learned_from = excluded.learned_from, source = excluded.source,
           discovered_addresses = excluded.discovered_addresses, updated_at = now()
     where domain_patterns.source <> 'verified_send'`,
    [domain, d.pattern, d.learnedFrom, d.source, discovery.onDomainAddresses])
}

async function savePattern(
  db: TaskDeps['db'], existing: PatternRecord | null,
  email: string, first: string, last: string,
) {
  const folded = foldPattern(existing, email, first, last)
  if (!folded) return
  // `source = 'verified_send'` is what makes this outrank an inferred pattern
  // on the next lead for this domain. Without it `loadPattern` would never see
  // a verified source and pattern discovery would overwrite a confirmed shape
  // with an inferred one on every run.
  await db.query(
    `insert into domain_patterns
       (domain, pattern, confidence, samples, learned_from, source, updated_at)
     values ($1,$2,$3,$4,$5,'verified_send',now())
     on conflict (domain) do update
       set pattern = excluded.pattern, confidence = excluded.confidence,
           samples = excluded.samples, learned_from = excluded.learned_from,
           source = 'verified_send', updated_at = now()`,
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
