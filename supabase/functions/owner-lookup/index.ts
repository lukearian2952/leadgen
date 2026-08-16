// Owner discovery — a first-class pipeline stage.
//
// Previously "the owner" was whatever an Apify actor happened to return, which
// on a 468-lead export meant 85% of rows had no first name at all. This stage
// exists to answer one question per lead: which human runs this business, and
// what mailbox reaches them?
//
// Three strategies, cheapest first, each only run when the previous found
// nothing:
//   (a) crawl the site's own about/team pages and extract (name, title) pairs
//   (b) ask a data provider for a named contact on the domain
//   (c) let the model propose an owner, and accept it only if the site
//       corroborates the name
//
// Then, for any lead with a name but no mailbox, construct candidate addresses
// and let Verifalia decide — refusing to guess at all on catch-all domains,
// where every guess would verify and none would be trustworthy.
//
// Runs in batches and self-chains, because an edge function has a wall clock
// and a campaign can have thousands of leads. current_step 21 means
// "owner-lookup in flight" the same way 20 means "Apify in flight".

import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { waitUntil } from '../_shared/edge.ts'
import { crawlForPeople, nameAppearsInText } from '../_shared/crawl.ts'
import {
  askJson, peoplePrompt, proposedOwnerPrompt,
  PEOPLE_SCHEMA, PROPOSED_OWNER_SCHEMA,
  addUsage, zeroUsage, type LlmUsage,
} from '../_shared/llm.ts'
import {
  parseName, isOwnerTitle, extractDomain, candidateEmails, catchAllProbe,
  isValidEmail, isGenericLocalPart, isJunkDomain, isFreemail, freemailAllowed,
} from '../_shared/identity.ts'
import { hasMxBatch } from '../_shared/dns.ts'
import { verifyEmails, isStrictlyDeliverable, probeSaysCatchAll } from '../_shared/verifalia.ts'
import { lookupOwnerByDomain, providerConfigured } from '../_shared/provider.ts'
import { startActor, ACTOR2 } from '../_shared/apify.ts'
import { finalizeCampaign } from '../_shared/finalize.ts'
import { recordSpend, type SpendCounters } from '../_shared/spend.ts'

/** Leads per invocation. Small enough that a batch finishes inside the wall clock. */
const BATCH = 10
const CONCURRENCY = 5

/** Stop picking up new leads after this, flush, and self-chain. */
const SOFT_DEADLINE_MS = 90_000

/** How long before an in-flight owner-lookup is considered dead and claimable. */
const STALE_LEASE_MS = 3 * 60_000

/** Cost control: at most one model call per lead per stage (a and c). */
const MAX_PATTERN_CANDIDATES = 6

interface LeadRow {
  id: string
  business_name: string
  website: string
  editorial_summary: string
  /** Hints left by actor1's enrichment records — a name it already found. */
  owner_email: string
  owner_first_name: string
  owner_last_name: string
  title: string
}

interface Resolved {
  leadId: string
  domain: string
  first: string
  last: string
  title: string
  isDoctor: boolean
  source: string
  /** A real mailbox from a provider — not a guess. */
  providerEmail: string
  /** Constructed addresses, in descending likelihood. */
  candidates: string[]
  /** Nonexistent local part on the same domain, to expose catch-all domains. */
  probe: string
  pagesFetched: number
}

async function log(
  sb: Db, campaignId: string, message: string, level = 'info',
) {
  await sb.from('campaign_logs').insert({ campaign_id: campaignId, step: 2, level, message })
}

// ── Per-lead owner discovery ─────────────────────────────────────────────────

interface DiscoveryOutcome {
  resolved: Resolved
  usage: LlmUsage
  pageFetches: number
  providerCalls: number
}

async function discoverOwner(
  lead: LeadRow, anthropicKey: string | undefined,
): Promise<DiscoveryOutcome> {
  const domain = extractDomain(lead.website)
  const base: Resolved = {
    leadId: lead.id, domain,
    first: '', last: '', title: '', isDoctor: false, source: '',
    providerEmail: '', candidates: [], probe: '', pagesFetched: 0,
  }
  let usage = zeroUsage()
  let providerCalls = 0

  // A placeholder domain can never be contacted; spend nothing on it.
  if (!domain || isJunkDomain(domain)) {
    return { resolved: base, usage, pageFetches: 0, providerCalls }
  }

  // ── (0) A hint actor1 already left ────────────────────────────────────────
  //
  // Actor 1's enrichment records sometimes carry a real owner-titled person.
  // apify-webhook stores that name unverified; taking it here skips the crawl
  // and both model calls for that lead, which is the single largest cost saving
  // in this stage.
  if (lead.owner_first_name) {
    base.first = lead.owner_first_name
    base.last = lead.owner_last_name ?? ''
    base.title = lead.title ?? ''
    base.isDoctor = /\bdr\b|\bdoctor\b/i.test(lead.title ?? '')
    base.source = 'actor1_enriched'
    if (lead.owner_email && isValidEmail(lead.owner_email) && !isGenericLocalPart(lead.owner_email)) {
      base.providerEmail = lead.owner_email.toLowerCase()
    } else {
      base.candidates = candidateEmails(base.first, base.last, domain).slice(0, MAX_PATTERN_CANDIDATES)
    }
    base.probe = catchAllProbe(domain)
    return { resolved: base, usage, pageFetches: 0, providerCalls }
  }

  // ── (a) The site's own words ───────────────────────────────────────────────
  const crawl = await crawlForPeople(lead.website)
  base.pagesFetched = crawl.pagesFetched

  if (anthropicKey && crawl.text.length > 200) {
    const result = await askJson<{ people?: Array<{ full_name?: string; title?: string; confidence?: string }> }>(
      anthropicKey, peoplePrompt(lead.business_name, crawl.text), PEOPLE_SCHEMA, 1500,
    )
    usage = addUsage(usage, result.usage)

    for (const person of result.data?.people ?? []) {
      // Only owner-shaped titles qualify. A named receptionist is not a lead.
      if (!isOwnerTitle(person.title ?? '')) continue
      const parsed = parseName(person.full_name ?? '')
      if (parsed.reject) continue
      // Guard against a name the model produced that the page never contained.
      if (!nameAppearsInText(parsed.first, parsed.last, crawl.text)) continue

      base.first = parsed.first
      base.last = parsed.last
      base.title = (person.title ?? '').trim()
      base.isDoctor = parsed.isDoctor
      base.source = 'site_crawl'
      break
    }
  }

  // ── (b) A data provider ────────────────────────────────────────────────────
  if (!base.first) {
    const outcome = await lookupOwnerByDomain(domain)
    if (!outcome.skipped) providerCalls++
    const contact = outcome.contact
    if (contact) {
      const parsed = parseName(`${contact.firstName} ${contact.lastName}`.trim())
      if (!parsed.reject) {
        base.first = parsed.first
        base.last = parsed.last
        base.title = contact.title
        base.isDoctor = parsed.isDoctor
        base.source = contact.source
        if (contact.email && !isGenericLocalPart(contact.email)) {
          base.providerEmail = contact.email.toLowerCase()
        }
      }
    }
  }

  // ── (c) Model proposal, corroborated against the site ──────────────────────
  if (!base.first && anthropicKey && (crawl.text || lead.editorial_summary)) {
    const result = await askJson<{ found?: boolean; full_name?: string; title?: string }>(
      anthropicKey,
      proposedOwnerPrompt(lead.business_name, lead.editorial_summary ?? '', crawl.firstParagraph),
      PROPOSED_OWNER_SCHEMA, 400,
    )
    usage = addUsage(usage, result.usage)

    if (result.data?.found) {
      const parsed = parseName(result.data.full_name ?? '')
      // The corroboration check is the whole point of this stage: without it
      // the model will happily invent a plausible owner for any business.
      if (!parsed.reject && nameAppearsInText(parsed.first, parsed.last, crawl.text)) {
        base.first = parsed.first
        base.last = parsed.last
        base.title = (result.data.title ?? '').trim()
        base.isDoctor = parsed.isDoctor
        base.source = 'model_proposed'
      }
    }
  }

  // ── Candidate mailboxes ────────────────────────────────────────────────────
  if (base.first && !base.providerEmail) {
    base.candidates = candidateEmails(base.first, base.last, domain).slice(0, MAX_PATTERN_CANDIDATES)
    if (base.candidates.length) base.probe = catchAllProbe(domain)
  } else if (base.providerEmail) {
    // Still probe: a Deliverable verdict on a catch-all domain means nothing.
    base.probe = catchAllProbe(domain)
  }

  return { resolved: base, usage, pageFetches: crawl.pagesFetched, providerCalls }
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()
  const startedAt = Date.now()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = serviceClient(SUPABASE_URL, SERVICE_KEY)

  const { campaign_id, chained } = await req.json().catch(() => ({})) as
    { campaign_id?: string; chained?: boolean }
  if (!campaign_id) return errorResponse('campaign_id required')

  const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
  const APIFY_KEY     = Deno.env.get('APIFY_API_KEY')!
  const VERIF_USER    = Deno.env.get('VERIFALIA_USERNAME') ?? ''
  const VERIF_PASS    = Deno.env.get('VERIFALIA_PASSWORD') ?? ''
  const canVerify     = !!(VERIF_USER && VERIF_PASS)

  // Claim the stage. 20 = arriving from the Apify webhook, 21 = already in
  // owner-lookup.
  //
  // A continuation this function scheduled itself (`chained`) claims freely —
  // it is the live lease-holder. Anyone else (the watchdog, a Resume) may only
  // take over a step-21 campaign whose lease has expired, so a watchdog kick
  // cannot run a second batch alongside a healthy self-chain and double the
  // model and verification spend. Every lead write refreshes updated_at through
  // the campaigns_updated_at trigger, so a working batch renews its own lease.
  const staleIso = new Date(Date.now() - STALE_LEASE_MS).toISOString()

  let claim = sb.from('campaigns')
    .update({ current_step: 21, status: 'running', apify_run_id: null, apify_phase: null })
    .eq('id', campaign_id)
    .in('status', ['running', 'paused', 'pending'])

  claim = chained
    ? claim.eq('current_step', 21)
    : claim.or(`current_step.eq.20,and(current_step.eq.21,updated_at.lt.${staleIso})`)

  const { data: claimed } = await claim.select('id')

  if (!claimed?.length) {
    return jsonResponse({ skipped: true, reason: 'not ready for owner-lookup' })
  }

  const { data: batch } = await sb.from('leads')
    .select('id, business_name, website, editorial_summary, owner_email, owner_first_name, owner_last_name, title')
    .eq('campaign_id', campaign_id)
    .eq('owner_lookup_done', false)
    .neq('website', '')
    .limit(BATCH)

  const leads = (batch ?? []) as LeadRow[]

  // Nothing left to look up — hand off to the general-email actor, or finish.
  if (!leads.length) {
    return await advance(sb, campaign_id, APIFY_KEY, SUPABASE_URL, SERVICE_KEY)
  }

  const { count: remainingBefore } = await sb.from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign_id).eq('owner_lookup_done', false).neq('website', '')

  if (!ANTHROPIC_KEY) {
    await log(sb, campaign_id, 'ANTHROPIC_API_KEY is not set — site-crawl owner extraction is disabled', 'warning')
  }
  const provider = providerConfigured()
  if (!provider) {
    await log(sb, campaign_id,
      'No HUNTER_API_KEY or APOLLO_API_KEY — provider owner lookup is skipped; owners come from the site crawl only', 'warning')
  }

  // ── Discover owners, bounded concurrency, soft deadline ────────────────────

  const resolved: Resolved[] = []
  let usage = zeroUsage()
  let pageFetches = 0
  let providerCalls = 0
  let cursor = 0
  let deadlineHit = false

  async function worker() {
    while (cursor < leads.length) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) { deadlineHit = true; return }
      const lead = leads[cursor++]
      try {
        const outcome = await discoverOwner(lead, ANTHROPIC_KEY)
        resolved.push(outcome.resolved)
        usage = addUsage(usage, outcome.usage)
        pageFetches += outcome.pageFetches
        providerCalls += outcome.providerCalls
      } catch (err) {
        // A single bad site must not sink the batch; the lead is marked done
        // with no owner and the gate rejects it later.
        console.error('[owner-lookup] lead', lead.id, (err as Error).message)
        resolved.push({
          leadId: lead.id, domain: extractDomain(lead.website),
          first: '', last: '', title: '', isDoctor: false, source: '',
          providerEmail: '', candidates: [], probe: '', pagesFetched: 0,
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leads.length) }, worker))

  // ── MX for every domain in the batch ──────────────────────────────────────

  const mxMap = await hasMxBatch(resolved.map(r => r.domain).filter(Boolean))

  // ── One Verifalia job for the whole batch ─────────────────────────────────

  const toVerify: string[] = []
  for (const r of resolved) {
    if (mxMap.get(r.domain) !== true) continue      // no MX: nothing to verify
    if (r.providerEmail) toVerify.push(r.providerEmail)
    toVerify.push(...r.candidates)
    if (r.probe) toVerify.push(r.probe)
  }

  let verified = new Map<string, { classification: string; status: string }>()
  let verifyIncomplete = false

  if (canVerify && toVerify.length) {
    const outcome = await verifyEmails(toVerify, VERIF_USER, VERIF_PASS)
    verified = outcome.results
    verifyIncomplete = outcome.incomplete
    if (outcome.error) {
      await log(sb, campaign_id, `Verifalia: ${outcome.error}`, 'warning')
    }
  } else if (toVerify.length) {
    // Unverified addresses are exactly what produced the bounce rate, so this
    // is fatal for the affected rows rather than a "save anyway".
    verifyIncomplete = true
    await log(sb, campaign_id, 'Verifalia credentials are not set — rows parked as pending_verify', 'warning')
  }

  // ── Persist ───────────────────────────────────────────────────────────────

  let named = 0
  let mailable = 0
  let parked = 0
  let catchAll = 0

  for (const r of resolved) {
    const mxOk = mxMap.get(r.domain) ?? null
    if (r.first) named++

    const probeEntry = r.probe ? verified.get(r.probe) : undefined
    const domainCatchAll = r.probe && (probeEntry || !verifyIncomplete)
      ? probeSaysCatchAll(probeEntry)
      : null
    if (domainCatchAll) catchAll++

    let ownerEmail = ''
    let ownerStatus = ''
    let verifaliaStatus = ''
    let pendingVerify = false

    const attempted = [
      ...(r.providerEmail ? [r.providerEmail] : []),
      ...(domainCatchAll ? [] : r.candidates),   // never guess into a catch-all
    ]

    if (mxOk === true && attempted.length) {
      const anyVerdict = attempted.some(e => verified.has(e))
      if (!anyVerdict && verifyIncomplete) {
        // No verdict and verification was unreliable — retry later rather than
        // shipping an unverified address.
        pendingVerify = true
        parked++
      } else {
        for (const email of attempted) {
          const entry = verified.get(email)
          if (isStrictlyDeliverable(entry)) {
            ownerEmail = email
            ownerStatus = 'deliverable'
            verifaliaStatus = entry!.status
            break
          }
        }
        // Record the best verdict we did get, so the reject reason is specific.
        if (!ownerEmail) {
          const first = attempted.map(e => verified.get(e)).find(Boolean)
          ownerStatus = (first?.classification ?? '').toLowerCase()
          verifaliaStatus = first?.status ?? ''
        }
      }
    }

    // Freemail from a provider only survives under the narrow gate rule.
    if (ownerEmail && isFreemail(ownerEmail.split('@')[1] ?? '') &&
        !freemailAllowed(ownerEmail, r.first, r.last, r.domain)) {
      ownerEmail = ''
      ownerStatus = ''
    }

    if (ownerEmail) mailable++

    await sb.from('leads').update({
      owner_first_name:  r.first,
      owner_last_name:   r.last,
      owner_name:        [r.first, r.last].filter(Boolean).join(' '),
      title:             r.title,
      is_doctor:         r.isDoctor,
      owner_source:      r.source,
      owner_email:       ownerEmail,
      email_status:      ownerStatus,
      email_verifalia_status: verifaliaStatus,
      mx_ok:             mxOk,
      domain_catch_all:  domainCatchAll,
      pending_verify:    pendingVerify,
      owner_lookup_done: true,
      owner_strategy:    r.source || 'not_found',
      step2_done:        true,
    }).eq('id', r.leadId)
  }

  // ── Spend ─────────────────────────────────────────────────────────────────

  const spend: SpendCounters = {
    haiku_input_token:  usage.inputTokens,
    haiku_output_token: usage.outputTokens,
    verifalia_credit:   new Set(toVerify).size,
    page_fetch:         pageFetches,
  }
  await recordSpend(sb, campaign_id, spend)

  await log(sb, campaign_id,
    `Owner lookup: ${named}/${resolved.length} named · ${mailable} verified mailbox` +
    `${catchAll ? ` · ${catchAll} catch-all domains skipped` : ''}` +
    `${parked ? ` · ${parked} awaiting re-verification` : ''}`,
    mailable > 0 ? 'success' : 'info')

  const remaining = (remainingBefore ?? leads.length) - resolved.length

  if (remaining > 0) {
    // Self-chain. Fire-and-forget so this invocation can return promptly.
    const next = fetch(`${SUPABASE_URL}/functions/v1/owner-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ campaign_id, chained: true }),
    }).catch(() => {})
  waitUntil(next)
    return jsonResponse({ processed: resolved.length, remaining, named, mailable, deadlineHit })
  }

  const advanced = await advance(sb, campaign_id, APIFY_KEY, SUPABASE_URL, SERVICE_KEY)
  return advanced
})

/**
 * Owner lookup is finished. Leads that still have no general email get one more
 * pass from the deep email actor (a general inbox never satisfies the gate, but
 * it is a useful secondary column on rows that do pass); otherwise finish.
 */
async function advance(
  sb: Db,
  campaignId: string,
  apifyKey: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const { data: needsEmail } = await sb.from('leads')
    .select('website')
    .eq('campaign_id', campaignId)
    .eq('email', '')
    .neq('website', '')
    .limit(1000)

  const websites = [...new Set((needsEmail ?? []).map(l => l.website as string))]

  if (websites.length) {
    const runId = await startActor(
      sb, ACTOR2, { baseUrls: websites }, apifyKey,
      campaignId, 'actor2', supabaseUrl, serviceKey,
    )
    if (runId) {
      await sb.from('campaign_logs').insert({
        campaign_id: campaignId, step: 2, level: 'info',
        message: `Actor 2 started for ${websites.length} general-email lookups (run ${runId})`,
      })
      return jsonResponse({ done: true, next: 'actor2', runId })
    }
  }

  const result = await finalizeCampaign(sb, campaignId, 'Owner lookup complete')
  return jsonResponse({ done: true, ...result })
}
