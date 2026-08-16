// Apify run helpers.
//
// Extracted from apify-webhook so step2, owner-lookup and the webhook all start
// runs the same way — with the timeout cap and the run-id bookkeeping the
// watchdog depends on. A run started without those is a campaign that can
// strand.

import type { Db } from './db.ts'

export const APIFY_BASE = 'https://api.apify.com/v2'

export const ACTOR1 = 'vdrmota~contact-info-scraper'
export const ACTOR2 = 'fatihtahta~email-scraper-deep'

// Actor 3 (fatihtahta~waterfall-contact-enricher) is deliberately gone. Its
// Apollo.io credentials live inside the rented actor, cannot be set from here,
// and have returned 401 on every call — so the stage cost money and produced
// nothing. Owner discovery is the owner-lookup function's job now.

/** Actors default to a 7-day timeout; one hung crawl would strand a campaign. */
export const RUN_TIMEOUT_SECS = 2700

export async function getDataset<T>(datasetId: string, apiKey: string): Promise<T[]> {
  const res = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?limit=2000&clean=true`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  )
  if (!res.ok) return []
  return await res.json().catch(() => []) as T[]
}

/**
 * Start an actor with a completion webhook, and record the run so the watchdog
 * can reconcile the phase if that webhook never lands.
 */
export async function startActor(
  sb: Db,
  actorId: string,
  input: object,
  apiKey: string,
  campaignId: string,
  phase: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<string | null> {
  const webhooksParam = btoa(JSON.stringify([{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: `${supabaseUrl}/functions/v1/apify-webhook`,
    headersTemplate: `{"Authorization":"Bearer ${serviceKey}","Content-Type":"application/json"}`,
    payloadTemplate: `{"campaign_id":"${campaignId}","phase":"${phase}","resource":{{resource}}}`,
  }]))

  const res = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?timeout=${RUN_TIMEOUT_SECS}&webhooks=${encodeURIComponent(webhooksParam)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  if (!res.ok) return null

  const json = await res.json().catch(() => null) as { data?: { id?: string } } | null
  const runId = json?.data?.id
  if (!runId) return null

  await sb.from('campaigns')
    .update({ apify_run_id: runId, apify_phase: phase, current_step: 20 })
    .eq('id', campaignId)

  return runId
}
