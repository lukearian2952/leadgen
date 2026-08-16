// Closing a campaign out: run the gate over every lead, write the verdicts, and
// set the headline numbers.
//
// Shared because three callers finish campaigns — apify-webhook on the last
// actor, owner-lookup when nothing is left to enrich, and the watchdog when a
// run is unrecoverable. They must reach identical verdicts, or the export and
// the dashboard disagree about what a campaign produced.

import type { Db } from './db.ts'
import { evaluateGate, reasonFamily, type GateLead } from './gate.ts'
import { resolveLocationScope } from './geo.ts'
import { resolveNicheFilter } from './niche-types.ts'

/** Below this share of gate-passing leads, the list is not safe to send. */
export const LOW_YIELD_THRESHOLD = 0.25

const GATE_COLUMNS = `
  id, owner_first_name, owner_last_name, owner_email, email, website,
  state, country, formatted_address, place_types, business_status,
  mx_ok, domain_catch_all, email_status, email_verifalia_status, pending_verify
`

async function log(
  sb: Db, campaignId: string, message: string, level = 'info',
) {
  await sb.from('campaign_logs').insert({ campaign_id: campaignId, step: 2, level, message })
}

export interface FinalizeResult {
  total: number
  ownerReady: number
  rejected: number
  emails: number
  owners: number
  lowYield: boolean
  topReasons: Array<[string, number]>
}

export async function finalizeCampaign(
  sb: Db,
  campaignId: string,
  note?: string,
): Promise<FinalizeResult> {
  // Anything still mid-enrichment has run out of stages.
  await sb.from('leads')
    .update({ step2_done: true, owner_lookup_done: true })
    .eq('campaign_id', campaignId)
    .eq('step2_done', false)

  const { data: campaign } = await sb.from('campaigns')
    .select('niche, location')
    .eq('id', campaignId)
    .single()

  const scope = await resolveLocationScope(
    (campaign?.location as string) ?? '',
    Deno.env.get('ANTHROPIC_API_KEY'),
  )
  const niche = resolveNicheFilter((campaign?.niche as string) ?? '')

  const { data: leads } = await sb.from('leads')
    .select(GATE_COLUMNS)
    .eq('campaign_id', campaignId)

  const rows = (leads ?? []) as unknown as Array<GateLead & { id: string }>

  // Bucket ids by verdict so this is a couple of dozen updates rather than one
  // per lead — a 500-lead campaign was otherwise 500 round trips.
  const passIds: string[] = []
  const byReason = new Map<string, string[]>()
  const reasonCounts = new Map<string, number>()

  for (const row of rows) {
    const verdict = evaluateGate(row, { scope, niche })
    if (verdict.pass) {
      passIds.push(row.id)
    } else {
      const list = byReason.get(verdict.reason) ?? []
      list.push(row.id)
      byReason.set(verdict.reason, list)
      const family = reasonFamily(verdict.reason)
      reasonCounts.set(family, (reasonCounts.get(family) ?? 0) + 1)
    }
  }

  const CHUNK = 200
  for (let i = 0; i < passIds.length; i += CHUNK) {
    await sb.from('leads')
      .update({ gate_passed: true, reject_reason: '' })
      .in('id', passIds.slice(i, i + CHUNK))
  }
  for (const [reason, ids] of byReason) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await sb.from('leads')
        .update({ gate_passed: false, reject_reason: reason })
        .in('id', ids.slice(i, i + CHUNK))
    }
  }

  const total = rows.length
  const ownerReady = passIds.length
  const rejected = total - ownerReady
  const emails = rows.filter(r => (r.owner_email ?? '') !== '' || (r.email ?? '') !== '').length
  const owners = rows.filter(r => (r.owner_email ?? '') !== '').length

  // Low yield is a real outcome, not an error: the run worked, the list just
  // isn't safe to upload. It gets its own status so the UI can say so.
  const lowYield = total > 0 && (ownerReady / total) < LOW_YIELD_THRESHOLD

  await sb.from('campaigns').update({
    step2_done:       emails,
    stat_emails:      emails,
    stat_owners:      owners,
    stat_owner_ready: ownerReady,
    stat_rejected:    rejected,
    current_step:     6,
    status:           lowYield ? 'completed_low_yield' : 'completed',
    completed_at:     new Date().toISOString(),
    apify_run_id:     null,
    apify_phase:      null,
  }).eq('id', campaignId)

  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

  const pct = total ? Math.round((ownerReady / total) * 100) : 0
  await log(sb, campaignId,
    `${note ? note + ' — ' : ''}${ownerReady}/${total} leads owner-ready (${pct}%)`,
    ownerReady > 0 ? 'success' : 'warning')

  if (topReasons.length) {
    await log(sb, campaignId,
      `Top reject reasons: ${topReasons.map(([r, n]) => `${r} ${n}`).join(' · ')}`)
  }

  if (lowYield) {
    await log(sb, campaignId,
      `Low yield: under ${Math.round(LOW_YIELD_THRESHOLD * 100)}% of scraped businesses produced a verified owner contact. Review the rejected export before sending anything.`,
      'warning')
  }

  return { total, ownerReady, rejected, emails, owners, lowYield, topReasons }
}
