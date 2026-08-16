import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { startActor, ACTOR1 } from '../_shared/apify.ts'
import { finalizeCampaign } from '../_shared/finalize.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = serviceClient(SUPABASE_URL, SERVICE_KEY)

  const { campaign_id } = await req.json().catch(() => ({})) as { campaign_id?: string }
  if (!campaign_id) return errorResponse('campaign_id required')

  const APIFY_KEY = Deno.env.get('APIFY_API_KEY')!

  // Atomic re-entry guard: only proceed if current_step is exactly 2, and flip
  // it to 20 in the same statement so two callers can't both start an actor.
  // Accepts paused/pending as well as running — otherwise a campaign paused at
  // step 2 could never be resumed.
  const { data: claimed } = await sb
    .from('campaigns')
    .update({ current_step: 20, status: 'running' })
    .eq('id', campaign_id).eq('current_step', 2)
    .in('status', ['running', 'paused', 'pending'])
    .select('id')

  if (!claimed?.length) {
    return jsonResponse({ skipped: true, reason: 'already in progress or not ready' })
  }

  const { data: leads } = await sb
    .from('leads')
    .select('id, website')
    .eq('campaign_id', campaign_id)
    .neq('website', '')

  if (!leads?.length) {
    // Nothing has a website, so nothing can clear the gate. Finalize rather
    // than start an actor with an empty input.
    const result = await finalizeCampaign(sb, campaign_id, 'No leads with a website')
    return jsonResponse({ enriched: 0, ...result })
  }

  await sb.from('campaign_logs').insert({
    campaign_id, step: 2, level: 'info',
    message: `Starting background enrichment for ${leads.length} leads — safe to close this tab`,
  })

  const runId = await startActor(
    sb, ACTOR1,
    {
      startUrls:                     leads.map(l => ({ url: l.website })),
      sameDomain:                    true,
      maxDepth:                      3,
      maxRequestsPerStartUrl:        15,
      mergeContacts:                 true,
      useBrowser:                    false,
      maximumLeadsEnrichmentRecords: 3,
      leadsEnrichmentDepartments:    ['c_suite'],
      verifyLeadsEnrichmentEmails:   false,
      proxyConfig:                   { useApifyProxy: true },
    },
    APIFY_KEY, campaign_id, 'actor1', SUPABASE_URL, SERVICE_KEY,
  )

  if (!runId) {
    await sb.from('campaign_logs').insert({
      campaign_id, step: 2, level: 'error',
      message: 'Failed to start Actor 1 — pausing so it can be resumed',
    })
    await sb.from('campaigns').update({ status: 'paused' }).eq('id', campaign_id)
    return errorResponse('Actor 1 start failed')
  }

  await sb.from('campaign_logs').insert({
    campaign_id, step: 2, level: 'info',
    message: `Actor 1 started (run ${runId}) — Apify will call back when done`,
  })

  return jsonResponse({ started: true, runId })
})
