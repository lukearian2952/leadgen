import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const STEP_FUNCTIONS: Record<number, string> = {
  1: 'step1-scrape-businesses',
  2: 'step2-enrich-contacts',
}

type StepResult = { processed?: number; remaining?: number; scraped?: number }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const supabase = serviceClient(SUPABASE_URL, SERVICE_KEY)

  const { campaign_id, resume } = await req.json().catch(() => ({})) as
    { campaign_id?: string; resume?: boolean }
  if (!campaign_id) return errorResponse('campaign_id required')

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, status, current_step')
    .eq('id', campaign_id)
    .single()

  if (!campaign) return errorResponse('Campaign not found', 404)

  // A resume explicitly re-opens a paused or failed campaign. Without this the
  // UI had to flip status to 'running' itself before calling — which then broke
  // the step functions' claim guards. Status transitions belong here, not in
  // the browser.
  const RESUMABLE = ['paused', 'failed']
  const startable = campaign.status === 'running' || campaign.status === 'pending' ||
                    (resume === true && RESUMABLE.includes(campaign.status as string))

  if (!startable) {
    return jsonResponse({ stopped: true, status: campaign.status })
  }

  const step = (campaign.current_step as number) || 1

  // Step 21 = owner lookup in flight. It is our own batched function, so the
  // orchestrator can call it directly; its stale-lease claim rejects the call
  // if a batch is genuinely still running, which makes Resume safe to spam.
  if (step === 21) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/owner-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ campaign_id }),
    }).catch(() => null)

    const resumed = res?.ok ? await res.json().catch(() => null) : null
    return jsonResponse({ status: 'owner_lookup_in_progress', resumed })
  }

  // Step 20 = enrichment in flight via Apify webhooks. There is no step function
  // to call, but this used to return unconditionally, which made Resume a no-op
  // for exactly the campaigns that needed it most — a lost webhook left them
  // here forever. Hand off to the watchdog, which reconciles against the real
  // Apify run state and either replays the missed webhook or closes the run out.
  if (step === 20) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/campaign-watchdog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ campaign_id }),
    }).catch(() => null)

    const reconciled = res?.ok ? await res.json().catch(() => null) : null
    return jsonResponse({ status: 'enrichment_in_progress', reconciled })
  }

  const fnName = STEP_FUNCTIONS[step]

  if (!fnName) {
    // No more steps — ensure campaign is marked completed
    await supabase.from('campaigns').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', campaign_id).in('status', ['running', 'pending'])
    return jsonResponse({ done: true, step })
  }

  let result: StepResult

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ campaign_id }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
    }

    result = await res.json() as StepResult
  } catch (err) {
    console.error('[orchestrator] step', step, (err as Error).message)
    await supabase.from('campaigns').update({ status: 'paused' }).eq('id', campaign_id)
    await supabase.from('campaign_logs').insert({
      campaign_id, step, level: 'error',
      message: `Pipeline error: ${(err as Error).message}`,
    })
    return errorResponse(`Step ${step} failed`, 500)
  }

  return jsonResponse({ step, ...result })
})
