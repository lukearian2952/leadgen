// Apify callbacks drive the enrichment chain.
//
// The chain is now: actor1 (site contact scrape) → owner-lookup → actor2 (deep
// email scrape, general inboxes only) → finalize.
//
// Actor 3 is gone. Its Apollo credentials were baked into the rented actor,
// returned 401 on every call, and so the stage cost money and produced nothing.
// Owner identity is the owner-lookup function's job.
//
// This file no longer decides whether an address is good enough to send to.
// It records what the actors found — general inboxes into `email`, and any
// named-owner hint into the owner columns *unverified* — and owner-lookup is
// the single place that verifies a mailbox and stamps `email_status`. That
// matters: an owner_email with an empty email_status can never pass the gate,
// so a hint that is never verified fails closed.

import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse } from '../_shared/cors.ts'
import { waitUntil } from '../_shared/edge.ts'
import { getDataset, startActor, ACTOR2 } from '../_shared/apify.ts'
import { finalizeCampaign } from '../_shared/finalize.ts'
import {
  isValidEmail, isGenericLocalPart, isJunkDomain, emailDomain,
  parseName, isOwnerTitle,
} from '../_shared/identity.ts'
import { recordSpend } from '../_shared/spend.ts'

interface WebhookBody {
  campaign_id: string
  phase: 'actor1' | 'actor2' | 'actor3'
  resource: { id: string; status: string; defaultDatasetId: string }
}

interface EnrichmentRecord {
  firstName?: string; lastName?: string; fullName?: string
  email?: string; jobTitle?: string; companySize?: string
}

interface Actor1Item {
  originalStartUrl: string; emails: string[]; leadsEnrichment?: EnrichmentRecord[]
}
interface Actor2Item { input_url: string; emails: string[] }

function normalise(url: string): string {
  try { return new URL(url.startsWith('http') ? url : `https://${url}`).href } catch { return url }
}

/**
 * Usable general inboxes. Deliberately NOT Verifalia-verified: a general inbox
 * is a supplementary column that never satisfies the gate, so spending a
 * verification credit on one buys nothing.
 */
function usableEmails(raw: string[]): string[] {
  return (raw ?? [])
    .map(e => (e ?? '').trim().toLowerCase())
    .filter(e => isValidEmail(e) && !isJunkDomain(emailDomain(e)))
}

/** Prefer a role inbox that is actually monitored over a random one. */
const GENERAL_PREFERENCE = ['info', 'hello', 'contact', 'office', 'frontdesk', 'reception']

function pickGeneralEmail(emails: string[]): string {
  if (!emails.length) return ''
  for (const stem of GENERAL_PREFERENCE) {
    const hit = emails.find(e => e.split('@')[0] === stem)
    if (hit) return hit
  }
  return emails[0]
}

async function log(
  sb: Db, campaign_id: string, message: string, level = 'info',
) {
  await sb.from('campaign_logs').insert({ campaign_id, step: 2, level, message })
}

/** Hand the campaign to owner-lookup. Fire-and-forget; the watchdog covers a drop. */
function kickOwnerLookup(campaignId: string, supabaseUrl: string, serviceKey: string) {
  const call = fetch(`${supabaseUrl}/functions/v1/owner-lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ campaign_id: campaignId }),
  }).catch(() => {})
  waitUntil(call)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_KEY    = Deno.env.get('APIFY_API_KEY')!

  const sb = serviceClient(SUPABASE_URL, SERVICE_KEY)

  const body = await req.json().catch(() => null) as WebhookBody | null
  if (!body?.campaign_id || !body?.phase || !body?.resource) {
    return jsonResponse({ error: 'invalid webhook payload' })
  }

  const { campaign_id, phase, resource } = body

  // A campaign left over from the old three-actor chain can still receive an
  // actor3 callback. Accept it, ignore the payload, and close the campaign out.
  if (phase === 'actor3') {
    await log(sb, campaign_id, 'Ignoring legacy actor3 callback — that stage has been removed', 'info')
    const result = await finalizeCampaign(sb, campaign_id, 'Legacy actor3 callback')
    return jsonResponse({ ok: true, ...result })
  }

  await recordSpend(sb, campaign_id, { apify_run: 1 })

  // A failed or aborted run often still has partial data worth keeping.
  let salvaged = false
  if (resource.status !== 'SUCCEEDED') {
    await log(sb, campaign_id,
      `Actor (${phase}) ended with status ${resource.status} — checking for partial data…`, 'warning')

    if (resource.defaultDatasetId) {
      const partial = await getDataset<Record<string, unknown>>(resource.defaultDatasetId, APIFY_KEY)
      if (partial.length > 0) {
        salvaged = true
        await log(sb, campaign_id, `Partial dataset has ${partial.length} items — processing them`)
      }
    }

    if (!salvaged) {
      // No data from this stage; move the chain forward anyway.
      if (phase === 'actor1') {
        await log(sb, campaign_id, 'Actor 1 produced nothing — going straight to owner lookup')
        kickOwnerLookup(campaign_id, SUPABASE_URL, SERVICE_KEY)
        return jsonResponse({ ok: true, next: 'owner-lookup' })
      }
      const result = await finalizeCampaign(sb, campaign_id, `Actor 2 ${resource.status}`)
      return jsonResponse({ ok: true, ...result })
    }
  }

  // ── Actor 1: general inboxes + named-owner hints ──────────────────────────

  if (phase === 'actor1') {
    await log(sb, campaign_id, 'Actor 1 finished — recording contacts…')

    const items = await getDataset<Actor1Item>(resource.defaultDatasetId, APIFY_KEY)

    const byUrl = new Map<string, Actor1Item>()
    for (const item of items) {
      if (!item?.originalStartUrl) continue
      byUrl.set(item.originalStartUrl, item)
      byUrl.set(normalise(item.originalStartUrl), item)
    }

    const { data: leads } = await sb.from('leads')
      .select('id, website')
      .eq('campaign_id', campaign_id)
      .neq('website', '')

    let withEmail = 0
    let withOwnerHint = 0

    for (const lead of leads ?? []) {
      const item = byUrl.get(lead.website as string) ?? byUrl.get(normalise(lead.website as string))
      if (!item) continue

      const update: Record<string, unknown> = {}

      const general = pickGeneralEmail(usableEmails(item.emails ?? []))
      if (general) { update.email = general; withEmail++ }

      // A named-owner hint: only when the title actually reads as an owner and
      // the name parses as a person. Everything else the actor returns is noise.
      const record = (item.leadsEnrichment ?? []).find(r => isOwnerTitle(r.jobTitle ?? ''))
      if (record) {
        const raw = record.fullName ?? `${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()
        const parsed = parseName(raw)
        if (!parsed.reject) {
          update.owner_first_name = parsed.first
          update.owner_last_name  = parsed.last
          update.owner_name       = [parsed.first, parsed.last].filter(Boolean).join(' ')
          update.title            = record.jobTitle ?? ''
          update.is_doctor        = parsed.isDoctor
          update.company_size     = record.companySize ?? ''
          update.owner_source     = 'actor1_enriched'
          // Unverified on purpose — owner-lookup verifies it in its batch, and
          // an empty email_status cannot pass the gate in the meantime.
          if (record.email && isValidEmail(record.email) && !isGenericLocalPart(record.email)) {
            update.owner_email = record.email.trim().toLowerCase()
          }
          withOwnerHint++
        }
      }

      if (Object.keys(update).length) {
        await sb.from('leads').update(update).eq('id', lead.id)
      }
    }

    await log(sb, campaign_id,
      `Actor 1: ${withEmail} general inboxes, ${withOwnerHint} named-owner hints from ${items.length} sites`,
      'success')

    kickOwnerLookup(campaign_id, SUPABASE_URL, SERVICE_KEY)
    return jsonResponse({ ok: true, next: 'owner-lookup' })
  }

  // ── Actor 2: general inboxes for whatever is still missing one ────────────

  if (phase === 'actor2') {
    await log(sb, campaign_id, 'Actor 2 finished — recording general inboxes…')

    const items = await getDataset<Actor2Item>(resource.defaultDatasetId, APIFY_KEY)

    const byUrl = new Map<string, string[]>()
    for (const item of items) {
      const emails = usableEmails(item?.emails ?? [])
      if (!emails.length || !item?.input_url) continue
      byUrl.set(item.input_url, emails)
      byUrl.set(normalise(item.input_url), emails)
    }

    const { data: leads } = await sb.from('leads')
      .select('id, website')
      .eq('campaign_id', campaign_id)
      .eq('email', '')
      .neq('website', '')

    let filled = 0
    for (const lead of leads ?? []) {
      const emails = byUrl.get(lead.website as string) ?? byUrl.get(normalise(lead.website as string)) ?? []
      const best = pickGeneralEmail(emails)
      if (!best) continue
      await sb.from('leads').update({ email: best }).eq('id', lead.id)
      filled++
    }

    await log(sb, campaign_id, `Actor 2: ${filled} additional general inboxes`, filled ? 'success' : 'info')

    const result = await finalizeCampaign(sb, campaign_id, 'Enrichment complete')
    return jsonResponse({ ok: true, ...result })
  }

  return jsonResponse({ error: `unknown phase: ${phase}` })
})
