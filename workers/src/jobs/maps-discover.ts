// maps:discover — turn a niche + location into filtered `leads` rows.
//
// Replaces v1's step1. Two filters still apply, for the same reasons:
//   * geo — Google returns out-of-region matches on thin queries ("Wellness New
//     York" produced Troy MI and Grand Bahama in v1)
//   * category — free-text matching pulls in gyms and nail bars for "med spa"
//
// Drop counts per reason go to job_runs so a thin campaign is diagnosable
// rather than mysterious.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey } from './wrap.js'
import type { TaskDeps } from './index.js'
import { MapsSource, parseCsv, type MapsBusiness } from '../sources/maps.js'
import { resolveLocationScope, checkInScope } from '../lib/geo.js'
import { resolveNicheFilter, checkNicheTypes } from '../lib/niche-types.js'
import { extractDomain, isJunkDomain } from '../lib/identity.js'
import { expandLocation } from '../lib/locations.js'

interface Payload {
  campaignId: string
  niche: string
  location: string
  targetCount: number
  [key: string]: unknown
}

/** Normalised business name, for dedupe and Phase 3 registry matching. */
export function normaliseName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[.,''"`]/g, '')
    .replace(/\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|limited|pllc|pc|pa|co|company|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function makeMapsDiscoverTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'maps:discover', db }, async (payload, ctx) => {
    const { campaignId, niche, location, targetCount } = payload
    const source = new MapsSource(config.mapsScraperUrl, ctx.logger)

    const scope = resolveLocationScope(location)
    const nicheFilter = resolveNicheFilter(niche)
    const cities = expandLocation(location)

    ctx.logger.info('maps discovery starting', {
      cities: cities.length, targetCount,
      scope: `${scope.stateCodes.join('/') || 'any'} in ${scope.countryCodes.join('/') || 'any'} (${scope.source})`,
      nicheFilter: nicheFilter.active ? nicheFilter.matchedKeyword : 'disabled',
    })

    // Maps always goes residential: Google localises by exit IP, so a
    // datacenter request returns a different result set even when not blocked.
    const proxies = residentialProxyUrls(config)

    const queries = cities.map(city => `${niche} in ${city}`)
    const jobId = await source.startJob(
      `${campaignId.slice(0, 8)}-maps`, queries, proxies,
      { depth: 10, maxSeconds: 1500 },
    )

    // 20 minute cap, per the brief. The wait now requires a non-empty download,
    // so `ok` here genuinely means there is something to parse.
    const wait = await source.waitFor(jobId, 20 * 60_000)
    if (wait.status !== 'ok') {
      throw new Error(
        wait.status === 'ok_but_empty'
          ? `maps job ${jobId} reported ok but /download stayed empty for the full 20 minute cap`
          : `maps job ${jobId} ended ${wait.status}`)
    }

    // waitFor already downloaded the body to prove it was non-empty; parsing
    // that rather than re-fetching avoids a second 120 s transfer and removes
    // the window where the scraper could truncate the file between calls.
    const raw = wait.body ? parseCsv(wait.body) : await source.results(jobId)
    ctx.logger.info('maps scrape complete', { returned: raw.length, bytes: wait.bytes })

    // ── filter ────────────────────────────────────────────────────────────────
    const drops: Record<string, number> = {}
    const drop = (reason: string) => {
      const family = reason.split(':')[0]
      drops[family] = (drops[family] ?? 0) + 1
    }

    const seenPlace = new Set<string>()
    const seenKey = new Set<string>()
    const kept: MapsBusiness[] = []

    for (const b of raw) {
      if (kept.length >= targetCount) break

      const dedupeKey = b.placeId || `${normaliseName(b.name)}|${b.phone}`
      if (!dedupeKey.trim()) { drop('no_identity'); continue }
      if (seenPlace.has(dedupeKey) || seenKey.has(dedupeKey)) { drop('duplicate'); continue }
      seenPlace.add(dedupeKey); seenKey.add(dedupeKey)

      const scopeReason = checkInScope(
        { state: b.state, country: b.country, formattedAddress: b.address }, scope)
      if (scopeReason) { drop(scopeReason); continue }

      // gosom gives one category string where v1 had a types array.
      const typeReason = checkNicheTypes([b.category], nicheFilter)
      if (typeReason && nicheFilter.active) {
        // The category vocabulary differs from Place types, so a mismatch is
        // only trusted when the category text also fails a keyword check —
        // otherwise a legitimate "Medical spa" would be dropped for not being
        // the literal string "spa".
        const catText = b.category.toLowerCase()
        const keywordHit = [...nicheFilter.allowed].some(t => catText.includes(t.replace(/_/g, ' ')))
          || catText.includes(nicheFilter.matchedKeyword)
        if (!keywordHit) { drop(typeReason); continue }
      }

      kept.push(b)
    }

    // ── persist ───────────────────────────────────────────────────────────────
    let inserted = 0
    for (const b of kept) {
      const domain = b.website ? extractDomain(b.website) : ''
      const usableDomain = domain && !isJunkDomain(domain) ? domain : ''

      const { rows } = await db.query<{ id: string }>(
        `insert into businesses
           (domain, name, name_norm, phone, website, street, city, state, postal_code,
            country, category, place_id, latitude, longitude, rating, review_count,
            sources, evidence, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 array['google_maps'], $17, now())
         on conflict (domain) where domain is not null and domain <> ''
         do update set last_seen_at = now(),
                       review_count = excluded.review_count,
                       rating = excluded.rating
         returning id`,
        [usableDomain || null, b.name, normaliseName(b.name), b.phone, b.website,
         b.street, b.city, b.state, b.postalCode, b.country, b.category, b.placeId,
         b.latitude, b.longitude, b.rating, b.reviewCount,
         JSON.stringify({ maps_link: b.link, address: b.address })],
      ).catch(async () => {
        // No domain: the partial unique index does not apply, so insert plainly.
        return db.query<{ id: string }>(
          `insert into businesses
             (domain, name, name_norm, phone, website, street, city, state, postal_code,
              country, category, place_id, latitude, longitude, rating, review_count,
              sources, evidence)
           values (null,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   array['google_maps'], $16)
           returning id`,
          [b.name, normaliseName(b.name), b.phone, b.website, b.street, b.city, b.state,
           b.postalCode, b.country, b.category, b.placeId, b.latitude, b.longitude,
           b.rating, b.reviewCount, JSON.stringify({ maps_link: b.link })],
        )
      })

      const businessId = rows[0]?.id ?? null

      const { rows: leadRows } = await db.query<{ id: string }>(
        `insert into leads
           (campaign_id, business_id, business_name, phone, website, place_id, city, state,
            country, formatted_address, category, email, sources, evidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,array['google_maps'],$13)
         returning id`,
        [campaignId, businessId, b.name, b.phone, b.website, b.placeId, b.city, b.state,
         b.country, b.address, b.category,
         b.emails[0] ?? '',
         JSON.stringify({
           maps_link: b.link,
           maps_emails: b.emails,
           maps_owner: b.owner || undefined,
           category: b.category,
           review_count: b.reviewCount,
         })],
      )
      inserted++

      // Chain: one crawl job per lead that has a usable website.
      if (usableDomain) {
        await ctx.helpers.addJob('crawl:site',
          { campaignId, leadId: leadRows[0].id, website: b.website, domain: usableDomain,
            businessName: b.name },
          { jobKey: jobKey('crawl:site', campaignId, leadRows[0].id), maxAttempts: 3 })
      } else {
        await db.query(
          `update leads set crawl_done = true, enrich_done = true,
                            tier = 'rejected', reject_reason = $2 where id = $1`,
          [leadRows[0].id, b.website ? 'junk_domain' : 'no_website'])
      }
    }

    const dropped = Object.values(drops).reduce((a, b) => a + b, 0)
    ctx.cost.detail = { returned: raw.length, kept: inserted, dropped, drops }
    ctx.logger.info('maps discovery complete', { returned: raw.length, kept: inserted, dropped, drops })

    await db.query(
      `update campaigns set step1_done = $2, stat_dropped_step1 = $3, current_step = 2 where id = $1`,
      [campaignId, inserted, dropped])

    // Finalize runs once the per-lead fan-out drains. The scheduler's reconcile
    // job is what actually detects that; this seeds it.
    await ctx.helpers.addJob('campaign:reconcile', { campaignId },
      { jobKey: jobKey('campaign:reconcile', campaignId), runAt: new Date(Date.now() + 60_000) })
  })
}

/** Proxy URLs handed to the scraper subprocess, which cannot use ProxyPool. */
function residentialProxyUrls(config: TaskDeps['config']): string[] {
  const { username, password, host, country, rotatingPort, stickyPortMin } = config.decodo
  if (!username || !password || !host) return []
  const user = country ? `user-${username}-country-${country}` : username
  // A handful of distinct exits so one blocked IP does not stall the scrape.
  const ports = [rotatingPort, stickyPortMin, stickyPortMin + 1, stickyPortMin + 2]
  return ports.map(p => `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${p}`)
}
