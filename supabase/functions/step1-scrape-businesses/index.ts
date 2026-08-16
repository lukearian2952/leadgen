import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { waitUntil } from '../_shared/edge.ts'
import { expandLocation } from '../_shared/owner-patterns.ts'
import { resolveLocationScope, extractAddressFacts, checkInScope } from '../_shared/geo.ts'
import { resolveNicheFilter, checkNicheTypes } from '../_shared/niche-types.ts'
import { recordSpend, type SpendCounters } from '../_shared/spend.ts'

const MAPS_BASE = 'https://maps.googleapis.com/maps/api/place'

/**
 * Place Details fields. The last five are new: without an address we cannot
 * tell whether a result is actually in the requested state (a "Wellness New
 * York" run returned Troy MI and Grand Bahama), and without `types` we cannot
 * tell a med spa from the nail bar next door.
 */
const DETAIL_FIELDS = [
  'name', 'formatted_phone_number', 'website',
  'formatted_address', 'address_components', 'types',
  'business_status', 'user_ratings_total', 'editorial_summary',
].join(',')

// Retry with exponential backoff — handles transient network errors and OVER_QUERY_LIMIT
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4, baseDelay = 2000): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt) + Math.random() * 500))
      }
    }
  }
  throw lastErr
}

async function mapsTextSearch(query: string, apiKey: string, pageToken?: string) {
  return withRetry(async () => {
    const params = new URLSearchParams({ query, key: apiKey })
    if (pageToken) params.set('pagetoken', pageToken)
    const r = await fetch(`${MAPS_BASE}/textsearch/json?${params}`)
    if (!r.ok) throw new Error(`Maps HTTP ${r.status}`)
    const data = await r.json() as { status: string; results?: unknown[]; next_page_token?: string; error_message?: string }
    if (data.status === 'OVER_QUERY_LIMIT') throw new Error('OVER_QUERY_LIMIT')
    if (data.status === 'REQUEST_DENIED') throw new Error(`REQUEST_DENIED: ${data.error_message ?? ''}`)
    return data
  })
}

interface PlaceDetails {
  name?: string
  formatted_phone_number?: string
  website?: string
  formatted_address?: string
  address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>
  types?: string[]
  business_status?: string
  user_ratings_total?: number
  editorial_summary?: { overview?: string }
}

async function mapsPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails> {
  return withRetry(async () => {
    const params = new URLSearchParams({ place_id: placeId, fields: DETAIL_FIELDS, key: apiKey })
    const r = await fetch(`${MAPS_BASE}/details/json?${params}`)
    if (!r.ok) throw new Error(`Place details HTTP ${r.status}`)
    const data = await r.json() as { status: string; result?: PlaceDetails }
    if (data.status === 'OVER_QUERY_LIMIT') throw new Error('OVER_QUERY_LIMIT')
    return data.result ?? {}
  }, 3, 1500)
}

async function log(supabase: Db, campaignId: string, message: string, level = 'info', step = 1) {
  await supabase.from('campaign_logs').insert({ campaign_id: campaignId, step, level, message })
}

const SAVE_BATCH = 25   // save to DB every N businesses scraped
const INTER_CITY_DELAY = 300  // ms between cities

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const supabase = serviceClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { campaign_id } = await req.json().catch(() => ({})) as { campaign_id?: string }
  if (!campaign_id) return errorResponse('campaign_id required')

  // Atomic claim with a stale lease. The old version only accepted
  // pending/paused, so a campaign whose step 1 died mid-run stayed 'running'
  // and could never be picked up again — and the UI's Resume set status to
  // 'running' before calling, guaranteeing the claim missed every time.
  //
  // A live step 1 flushes leads every 25 businesses, and the campaigns_updated_at
  // trigger refreshes updated_at on each write, so an actually-running scrape
  // renews its own lease and will not be taken over.
  const { data: claimed } = await supabase.rpc('claim_campaign_step', {
    p_campaign_id: campaign_id,
    p_step:        1,
    p_stale_after: '3 minutes',
  })

  if (!claimed?.length) {
    const { data: cur } = await supabase.from('campaigns').select('status').eq('id', campaign_id).single()
    if (cur?.status === 'running') return jsonResponse({ skipped: true, reason: 'step1 already in progress' })
    return errorResponse(`Campaign is ${cur?.status ?? 'unknown'}`)
  }

  const campaign = claimed[0]
  const MAPS_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY')!
  const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')

  // --- Load existing progress so we can checkpoint-resume after timeouts ---
  const { data: existingLeads } = await supabase
    .from('leads')
    .select('place_id, city')
    .eq('campaign_id', campaign_id)

  const seenIds = new Set<string>()
  const cityLeadCount: Record<string, number> = {}
  let alreadySavedCount = 0

  if (existingLeads?.length) {
    for (const l of existingLeads) {
      seenIds.add(l.place_id)
      cityLeadCount[l.city] = (cityLeadCount[l.city] || 0) + 1
      alreadySavedCount++
    }
  }

  const cities = await expandLocation(campaign.location, ANTHROPIC_KEY)

  // What counts as "inside the requested location", and what counts as the
  // right kind of business. Both are resolved once per run.
  const scope = await resolveLocationScope(campaign.location, ANTHROPIC_KEY)
  const nicheFilter = resolveNicheFilter(campaign.niche)

  if (alreadySavedCount > 0) {
    await log(supabase, campaign_id, `Resuming: ${alreadySavedCount} leads already saved, continuing across ${cities.length} cities`, 'info', 0)
  } else {
    const sourceLabel = ANTHROPIC_KEY ? 'AI-expanded' : 'static'
    await log(supabase, campaign_id, `Starting lead generation: ${campaign.niche} in ${campaign.location}`, 'info', 0)
    await log(supabase, campaign_id, `${sourceLabel} to ${cities.length} cities: ${cities.slice(0, 5).join(', ')}${cities.length > 5 ? `... +${cities.length - 5} more` : ''}`)
  }

  const scopeLabel = scope.source === 'unscoped'
    ? 'could not resolve — location filter disabled'
    : `${scope.stateCodes.join('/') || 'any state'} in ${scope.countryCodes.join('/') || 'any country'} (${scope.source})`
  await log(supabase, campaign_id, `Location filter: ${scopeLabel}`)
  await log(supabase, campaign_id, nicheFilter.active
    ? `Business-type filter: "${nicheFilter.matchedKeyword}" → ${[...nicheFilter.allowed].join(', ')}`
    : `Business-type filter: no rule matches "${campaign.niche}" — type filter disabled`)

  const target: number = campaign.target_count
  const newBatch: Record<string, unknown>[] = []  // businesses scraped this run, not yet saved
  let totalSaved = alreadySavedCount               // running total (DB + this run)
  let cityErrors = 0

  // Counts per drop reason, so a campaign that returns almost nothing is
  // diagnosable from the log instead of guessed at.
  const drops: Record<string, number> = {}
  const dropped = (reason: string) => {
    const family = reason.split(':')[0]
    drops[family] = (drops[family] ?? 0) + 1
  }

  const spend: SpendCounters = { maps_text_search: 0, maps_place_details: 0 }

  async function flushBatch() {
    if (!newBatch.length) return
    const chunk = newBatch.splice(0, newBatch.length).map(b => ({ ...b, campaign_id }))
    await supabase.from('leads').insert(chunk)
    totalSaved += chunk.length
    await supabase.from('campaigns').update({
      step1_done: totalSaved,
      stat_dropped_step1: Object.values(drops).reduce((a, b) => a + b, 0),
    }).eq('id', campaign_id)
  }

  outer:
  for (const city of cities) {
    if (totalSaved + newBatch.length >= target) break

    // Skip cities that are likely fully exhausted (60+ leads means we had 3 full pages)
    if ((cityLeadCount[city] ?? 0) >= 60) continue

    if (totalSaved + newBatch.length > alreadySavedCount) {
      await new Promise(r => setTimeout(r, INTER_CITY_DELAY))
    }

    const query = `${campaign.niche} in ${city}`
    let pageToken: string | undefined

    for (let page = 0; page < 3; page++) {
      if (totalSaved + newBatch.length >= target) break outer
      try {
        if (pageToken) await new Promise(r => setTimeout(r, 2000))
        const data = await mapsTextSearch(query, MAPS_KEY, pageToken)
        spend.maps_text_search = (spend.maps_text_search ?? 0) + 1
        const results = (data.results ?? []) as Array<{ place_id?: string; name?: string }>

        if (data.status === 'ZERO_RESULTS') break

        for (const result of results) {
          if (totalSaved + newBatch.length >= target) break
          const pid = result.place_id
          if (!pid || seenIds.has(pid)) continue
          seenIds.add(pid)

          let details: PlaceDetails = {}
          try {
            details = await mapsPlaceDetails(pid, MAPS_KEY)
            spend.maps_place_details = (spend.maps_place_details ?? 0) + 1
          } catch {
            // Without details there is no address and no types, so the place
            // cannot clear gate rules 4 and 5. Previously it was kept anyway.
            dropped('no_place_details')
            continue
          }

          const status = details.business_status ?? ''
          if (status && status !== 'OPERATIONAL') {
            dropped(`business_${status.toLowerCase()}`)
            continue
          }

          const facts = extractAddressFacts(details.address_components, details.formatted_address ?? '')
          const scopeReason = checkInScope(facts, scope)
          if (scopeReason) { dropped(scopeReason); continue }

          const types = details.types ?? []
          const typeReason = checkNicheTypes(types, nicheFilter)
          if (typeReason) { dropped(typeReason); continue }

          newBatch.push({
            business_name:     details.name ?? result.name ?? '',
            short_name:        '',
            phone:             details.formatted_phone_number ?? '',
            website:           details.website ?? '',
            place_id:          pid,
            city,
            state:             facts.state,
            country:           facts.country,
            formatted_address: facts.formattedAddress,
            place_types:       types,
            rating_count:      details.user_ratings_total ?? 0,
            business_status:   status,
            editorial_summary: details.editorial_summary?.overview ?? '',
          })

          const runningTotal = totalSaved + newBatch.length
          if (runningTotal % 10 === 0) {
            await log(supabase, campaign_id, `Scraped ${runningTotal} businesses...`)
          }

          // Flush to DB every SAVE_BATCH businesses so progress survives timeout kills
          if (newBatch.length >= SAVE_BATCH) {
            await flushBatch()
          }
        }

        pageToken = data.next_page_token
        if (!pageToken) break
      } catch (err) {
        cityErrors++
        const msg = (err as Error).message
        await log(supabase, campaign_id, `Error scraping ${city}: ${msg}`, 'warning')
        if (msg.includes('OVER_QUERY_LIMIT')) {
          await flushBatch()  // save progress before pausing
          await new Promise(r => setTimeout(r, 5000))
        }
        break
      }
    }
  }

  // Final flush of anything remaining
  await flushBatch()
  await recordSpend(supabase, campaign_id, spend)

  if (cityErrors > 0) {
    await log(supabase, campaign_id, `${cityErrors} city/page errors skipped — ${totalSaved} total leads saved`, 'warning')
  }

  const totalDropped = Object.values(drops).reduce((a, b) => a + b, 0)
  if (totalDropped > 0) {
    const breakdown = Object.entries(drops)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n}`)
      .join(' · ')
    await log(supabase, campaign_id,
      `Filtered out ${totalDropped} places before saving — ${breakdown}`,
      totalDropped > totalSaved ? 'warning' : 'info')
  }

  await supabase.from('campaigns').update({
    step1_done:         totalSaved,
    stat_dropped_step1: totalDropped,
    current_step:       2,
  }).eq('id', campaign_id)
  await log(supabase, campaign_id, `Step 1 complete: ${totalSaved} businesses kept. Starting contact enrichment…`, 'success', 0)

  // Chain to orchestrator for step 2 (fire-and-forget)
  const step2Call = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/campaign-orchestrator`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify({ campaign_id }),
  }).catch(() => {})
  waitUntil(step2Call)

  return jsonResponse({ scraped: totalSaved, dropped: totalDropped, drops })
})
