import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse } from '../_shared/cors.ts'
import { finalizeCampaign } from '../_shared/finalize.ts'
import { APIFY_BASE } from '../_shared/apify.ts'

// A campaign that hasn't written anything for this long is worth investigating.
// Live steps flush progress every few seconds, so this is generous.
const STALE_MINUTES = 5

// An Apify run allowed to exceed this is killed. Actors default to a 7-day
// timeout, which is how a single hung run stalls a campaign indefinitely.
const RUN_HARD_CAP_MINUTES = 45

// Verifalia can fail transiently. Rows parked as pending_verify get this many
// attempts before the gate rejects them for good — a bounded retry, so a
// permanently unverifiable address cannot cycle forever.
const MAX_VERIFY_ATTEMPTS = 3

const TERMINAL = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']

/** current_step values that are not a step function: 20 = Apify, 21 = owner-lookup. */
const STEP_APIFY = 20
const STEP_OWNER_LOOKUP = 21

interface ApifyRun {
  id: string
  status: string
  startedAt: string
  defaultDatasetId: string
}

async function log(
  sb: Db, campaign_id: string, message: string, level = 'info',
) {
  await sb.from('campaign_logs').insert({
    campaign_id, step: 0, level, message: `[watchdog] ${message}`,
  })
}

async function getRun(runId: string, apiKey: string): Promise<ApifyRun | null> {
  try {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return null
    const json = await res.json() as { data: ApifyRun }
    return json.data
  } catch { return null }
}

async function abortRun(runId: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}/abort`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
    })
    return res.ok
  } catch { return false }
}

async function post(
  url: string, serviceKey: string, body: unknown,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch { return false }
}

/**
 * Re-deliver a webhook Apify already fired (or never managed to). The
 * apify-webhook handler is the single place that knows how to advance the
 * actor chain, so recovery replays into it rather than duplicating that logic.
 */
function redeliverWebhook(
  campaign_id: string, phase: string, run: ApifyRun,
  supabaseUrl: string, serviceKey: string,
): Promise<boolean> {
  return post(`${supabaseUrl}/functions/v1/apify-webhook`, serviceKey, {
    campaign_id, phase,
    resource: { id: run.id, status: run.status, defaultDatasetId: run.defaultDatasetId },
  })
}

/**
 * Re-queue rows whose mailbox never got a Verifalia verdict.
 *
 * Owner-lookup skips the crawl and both model calls for a lead that already has
 * a name, so re-running it for these rows re-derives the same candidate
 * addresses and verifies them — no rediscovery cost, just the credits.
 */
async function retryPendingVerify(
  sb: Db,
  campaignId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<number> {
  const { data: parked } = await sb.from('leads')
    .select('id, verify_attempts')
    .eq('campaign_id', campaignId)
    .eq('pending_verify', true)
    .lt('verify_attempts', MAX_VERIFY_ATTEMPTS)
    .limit(500)

  if (!parked?.length) return 0

  for (const lead of parked) {
    await sb.from('leads').update({
      pending_verify:    false,
      owner_lookup_done: false,
      verify_attempts:   ((lead.verify_attempts as number) ?? 0) + 1,
    }).eq('id', lead.id)
  }

  await sb.from('campaigns')
    .update({ current_step: STEP_OWNER_LOOKUP, status: 'running' })
    .eq('id', campaignId)

  await post(`${supabaseUrl}/functions/v1/owner-lookup`, serviceKey, { campaign_id: campaignId })
  await log(sb, campaignId, `Re-queued ${parked.length} rows for email re-verification`)
  return parked.length
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_KEY    = Deno.env.get('APIFY_API_KEY')!

  const sb = serviceClient(SUPABASE_URL, SERVICE_KEY)

  // Allow targeting one campaign (used by the orchestrator's Resume path).
  const { campaign_id: only } = await req.json().catch(() => ({})) as { campaign_id?: string }

  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()

  let query = sb.from('campaigns')
    .select('id, status, current_step, apify_run_id, apify_phase, updated_at, stat_owner_ready, stat_rejected')
    .in('status', ['running', 'pending'])

  // A targeted check skips the staleness filter — the user is asking right now.
  if (only) query = query.eq('id', only)
  else      query = query.lt('updated_at', staleBefore)

  const { data: stalled, error } = await query

  if (error) return jsonResponse({ error: error.message }, 500)

  // A targeted call against an already-finished campaign is a re-judge request:
  // re-run the gate so a campaign completed before the gate existed (or one
  // whose rows have since been re-verified) gets current verdicts.
  if (only && !stalled?.length) {
    const { data: done } = await sb.from('campaigns')
      .select('id, status')
      .eq('id', only)
      .in('status', ['completed', 'completed_low_yield', 'failed', 'paused'])
      .maybeSingle()

    if (done) {
      const retried = await retryPendingVerify(sb, only, SUPABASE_URL, SERVICE_KEY)
      if (retried) {
        return jsonResponse({ checked: 1, actions: [{ campaign: only, action: 'reverifying' }] })
      }
      const result = await finalizeCampaign(sb, only, 'Re-judged on request')
      return jsonResponse({ checked: 1, actions: [{ campaign: only, action: 'regated' }], ...result })
    }
  }

  if (!stalled?.length) return jsonResponse({ checked: 0, actions: [] })

  const actions: Array<{ campaign: string; action: string }> = []

  for (const c of stalled) {
    // ── Owner lookup in flight ──────────────────────────────────────────────
    // No external run to reconcile: the stage is our own batched function and
    // its progress lives in leads.owner_lookup_done. Re-kicking is safe — its
    // stale-lease claim rejects the call if a batch is genuinely still running.
    if (c.current_step === STEP_OWNER_LOOKUP) {
      const ok = await post(`${SUPABASE_URL}/functions/v1/owner-lookup`, SERVICE_KEY, { campaign_id: c.id })
      await log(sb, c.id, ok ? 'Restarted stalled owner lookup' : 'Could not restart owner lookup',
        ok ? 'info' : 'error')
      if (!ok) await finalizeCampaign(sb, c.id, 'Owner lookup unrecoverable')
      actions.push({ campaign: c.id, action: ok ? 'owner_lookup_restarted' : 'finalized_owner_lookup_failed' })
      continue
    }

    // ── Enrichment in flight: reconcile against the actual Apify run ─────────
    if (c.current_step === STEP_APIFY) {
      if (!c.apify_run_id) {
        // Pre-watchdog campaign, or the run id was never recorded. Nothing to
        // poll and no way to resume the chain — keep the data, close the run.
        await finalizeCampaign(sb, c.id, 'No Apify run recorded')
        actions.push({ campaign: c.id, action: 'finalized_no_run_id' })
        continue
      }

      const run = await getRun(c.apify_run_id as string, APIFY_KEY)

      if (!run) {
        await finalizeCampaign(sb, c.id, `Apify run ${c.apify_run_id} not found`)
        actions.push({ campaign: c.id, action: 'finalized_run_missing' })
        continue
      }

      if (TERMINAL.includes(run.status)) {
        // The run finished but the campaign never moved — the webhook was lost.
        const ok = await redeliverWebhook(
          c.id as string, (c.apify_phase as string) ?? 'actor1', run, SUPABASE_URL, SERVICE_KEY)
        await log(sb, c.id,
          ok ? `Recovered missed ${c.apify_phase} webhook (run ${run.id} was ${run.status})`
             : `Failed to replay ${c.apify_phase} webhook for run ${run.id}`,
          ok ? 'info' : 'error')
        if (!ok) await finalizeCampaign(sb, c.id, 'Webhook replay failed')
        actions.push({ campaign: c.id, action: ok ? 'webhook_replayed' : 'finalized_replay_failed' })
        continue
      }

      // Still running. Only intervene once it blows the hard cap — a genuinely
      // working crawl can legitimately take many minutes.
      const ageMin = (Date.now() - new Date(run.startedAt).getTime()) / 60_000
      if (ageMin > RUN_HARD_CAP_MINUTES) {
        await log(sb, c.id,
          `Apify run ${run.id} exceeded ${RUN_HARD_CAP_MINUTES}m (${Math.round(ageMin)}m) — aborting`, 'warning')
        const aborted = await abortRun(run.id, APIFY_KEY)
        // The ABORTED webhook drives the chain forward; if the abort call
        // itself failed there is nothing left to wait on, so close it out.
        if (!aborted) await finalizeCampaign(sb, c.id, 'Run over hard cap and abort failed')
        actions.push({ campaign: c.id, action: aborted ? 'run_aborted' : 'finalized_abort_failed' })
        continue
      }

      // Healthy long-running crawl. Deliberately does NOT touch the campaign
      // row: leaving updated_at stale is what keeps it in the next scan so the
      // hard cap can still fire.
      actions.push({ campaign: c.id, action: 'in_progress' })
      continue
    }

    // ── Scrape/enrich steps: the step function died mid-run ──────────────────
    // claim_campaign_step's stale lease lets the retry take over cleanly, and
    // step 1 checkpoints its leads, so it picks up where it left off.
    const kicked = await post(
      `${SUPABASE_URL}/functions/v1/campaign-orchestrator`, SERVICE_KEY, { campaign_id: c.id })
    await log(sb, c.id,
      kicked ? `Restarted stalled step ${c.current_step}`
             : `Could not restart step ${c.current_step}`,
      kicked ? 'info' : 'error')
    actions.push({ campaign: c.id, action: kicked ? 'step_restarted' : 'restart_failed' })
  }

  return jsonResponse({ checked: stalled.length, actions })
})
