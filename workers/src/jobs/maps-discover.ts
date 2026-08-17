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
import { wrapTask, jobKey, type JobContext } from './wrap.js'
import type { TaskDeps } from './index.js'
import { MapsSource, parseCsv, type MapsBusiness } from '../sources/maps.js'
import { resolveLocationScope, checkInScope } from '../lib/geo.js'
import { resolveNicheFilter, checkNicheTypes, nicheQueryVariants } from '../lib/niche-types.js'
import { extractDomain, isJunkDomain } from '../lib/identity.js'
import { normaliseName } from '../lib/normalise.js'
import { expandLocation } from '../lib/locations.js'
import { recordSourceCost } from './crawl-site.js'
import { httpFetch } from '../net.js'
import type { Logger } from '../logger.js'

interface Payload {
  campaignId: string
  niche: string
  location: string
  targetCount: number
  /**
   * Adopt a scraper job that has already run instead of starting a new one.
   *
   * gosom keeps completed jobs and their CSVs. When our wait expires the job
   * fails, but the scrape underneath usually finishes moments later — the wrap
   * run timed out at 20 minutes and its job was `ok` with 182 rows shortly
   * after. Re-scraping to recover that is 20 more minutes of proxy traffic for
   * data already sitting on disk.
   */
  existingJobId?: string
  /**
   * Which slice of the expanded city list this job covers.
   *
   * A 1,000-business national run needs ~400 queries, and gosom falls over
   * past a few dozen at once — 48 concurrent queries produced 71 `target
   * closed` and 8 rows. So discovery is batched: each job takes
   * `MAPS_MAX_QUERIES` worth of cities and, when it finishes under target,
   * enqueues the next batch. Sequential by construction, because two
   * concurrent batches would recreate the overload this exists to avoid.
   */
  batchIndex?: number
  [key: string]: unknown
}

// Moved to lib/normalise.ts in Phase 3 so registry matching uses the identical
// function — two near-identical normalisers would quietly depress every trigram
// similarity score. Re-exported here for existing importers.
export { normaliseName } from '../lib/normalise.js'

export function makeMapsDiscoverTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'maps:discover', db }, async (payload, ctx) => {
    const { campaignId, niche, location, targetCount, existingJobId } = payload
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

    // Prove the exit IP before spending a scrape on it. Google localises by exit
    // IP, so an out-of-country exit returns plausible-looking results for the
    // wrong place — the failure mode is silent, which is why this is a hard
    // check and not a log line. First run of the auth-forwarding proxy came out
    // of Córdoba, Argentina while claiming US targeting.
    if (!existingJobId) await assertProxyExit(proxies[0], ctx.logger)

    // ── query set ─────────────────────────────────────────────────────────────
    //
    // cities x phrasings, capped. The cap is not cosmetic: the 48-query
    // statewide "vehicle wrap shop / New York" run came back with 8 rows total
    // while a 2-query probe of the same niche in the same cities returned 9 at
    // the same moment — gosom logged 71 `target closed`, 49 `unexpected page
    // type` and a run of 403/502s, i.e. it fell over under the load rather than
    // finding nothing. Fewer, denser queries beat more, thinner ones.
    const variants = nicheQueryVariants(niche)
    const perBatch = Math.max(1, Math.floor(maxQueries() / variants.length))
    const batchIndex = payload.batchIndex ?? 0

    // Cities already scraped for this campaign are never scraped again — not on
    // a retry, not on a resumed run. Every retry before this change re-bought
    // rows already in the database at full residential price.
    const { rows: doneRows } = await db.query<{ city: string }>(
      `select city from discovery_city_runs
        where campaign_id = $1 and status = 'ok'`, [campaignId])
    const alreadyDone = new Set(doneRows.map(r => r.city))

    const slice = cities.slice(batchIndex * perBatch, (batchIndex + 1) * perBatch)
    const batchCities = slice.filter(c => !alreadyDone.has(c))
    const moreBatches = (batchIndex + 1) * perBatch < cities.length

    if (slice.length !== batchCities.length) {
      ctx.logger.info('skipping cities already scraped for this campaign', {
        batchIndex, skipped: slice.length - batchCities.length, remaining: batchCities.length,
      })
    }

    if (!batchCities.length) {
      // Every city in this slice was already done. That is not the end of
      // discovery — the next slice may be untouched — so advance rather than
      // finishing, or a resumed run would stop at its first cached batch.
      if (moreBatches) {
        await ctx.helpers.addJob('maps:discover',
          { ...payload, batchIndex: batchIndex + 1 },
          { jobKey: jobKey(`maps:discover:${batchIndex + 1}`, campaignId), maxAttempts: 2 })
        ctx.cost.detail = { batchIndex, allCached: true, advancedTo: batchIndex + 1 }
        ctx.logger.info('batch fully cached — advancing', { batchIndex })
        return
      }
      ctx.logger.info('no cities left — discovery finished', { batchIndex })
      ctx.cost.detail = { batchIndex, exhausted: true }
      await finishDiscovery(ctx, db, campaignId)
      return
    }

    const queries: string[] = []
    for (const city of batchCities) {
      for (const variant of variants) queries.push(`${variant} in ${city}`)
    }
    // maxSeconds is deliberately above our own wait cap: if one of the two has
    // to give up first it should be us, so the scraper's own result is never
    // discarded half-written.
    const jobId = existingJobId ?? await source.startJob(
      `${campaignId.slice(0, 8)}-maps`, queries, proxies,
      { depth: mapsDepth(), maxSeconds: Math.round(mapsWaitMs(queries.length) / 1000) + 300 },
    )
    if (existingJobId) {
      ctx.logger.info('adopting an already-completed scraper job', { jobId })
    }

    // Zero the meter so the bytes we read back belong to this batch alone.
    // Only when we actually started a scrape — adopting a finished job spends
    // nothing and must not clear another batch's reading.
    if (!existingJobId) await resetMeter(ctx.logger)

    // ── how long to wait ──────────────────────────────────────────────────────
    //
    // The brief's cap was 20 minutes, chosen against a 30-city Long Island
    // scrape. A 48-city statewide scrape does not fit: "vehicle wrap shop" /
    // "New York" was still `working` at the cap and the job dead-lettered on
    // its final attempt with a perfectly good scrape running underneath it.
    //
    // The cap now scales with the number of queries — 30 s each, floored at the
    // original 20 minutes and ceilinged at 45 — and `MAPS_WAIT_MINUTES`
    // overrides it outright. gosom is started with `maxSeconds` above this, so
    // the scraper is never the thing that gives up first.
    const waitMs = mapsWaitMs(queries.length)
    ctx.logger.info('waiting for maps job', {
      jobId, queries: queries.length, waitMinutes: Math.round(waitMs / 60_000),
    })
    const wait = await source.waitFor(jobId, waitMs)
    if (wait.status !== 'ok') {
      throw new Error(
        wait.status === 'ok_but_empty'
          ? `maps job ${jobId} reported ok but /download stayed empty for the full ` +
            `${Math.round(waitMs / 60_000)} minute cap`
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

    // Batches overlap: neighbouring cities return the same businesses, and
    // without this the second batch re-inserts them as fresh leads and pays to
    // crawl and verify each one again.
    const { rows: existingRows } = await db.query<{ place_id: string }>(
      `select place_id from leads where campaign_id = $1 and place_id <> ''`, [campaignId])
    const seenPlace = new Set<string>(existingRows.map(r => r.place_id))
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
          || nicheFilter.hints.some(h => catText.includes(h))
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

    // ── residential bytes ─────────────────────────────────────────────────────
    //
    // The one stage that could not report its own proxy usage now can. Read
    // before anything else touches the meter, and attributed through the same
    // add_source_cost path every other stage uses so "MB per business" is one
    // query rather than a special case.
    const meter = existingJobId ? null : await readMeter(ctx.logger)
    if (meter) {
      await recordSourceCost(db, campaignId, 'google_maps', 'maps',
        inserted, { decodo_residential: meter.totalBytes }, 0, 0, 0)
      await db.query(`select add_residential_bytes($1, $2)`,
        [campaignId, meter.totalBytes])
    }

    // Cities are recorded whatever the yield: an `empty` city is still a city
    // we have paid to ask about, and re-asking would cost the same again.
    for (const city of batchCities) {
      await db.query(
        `insert into discovery_city_runs
           (campaign_id, city, queries, status, rows_returned, kept, batch_index)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (campaign_id, city) do update
           set status = excluded.status, rows_returned = excluded.rows_returned,
               kept = excluded.kept, ran_at = now()`,
        [campaignId, city, variants.map(v => `${v} in ${city}`),
         raw.length ? 'ok' : 'empty', raw.length, inserted, batchIndex])
    }

    // Campaign totals, not batch totals — step1_done accumulates across batches.
    const { rows: [totals] } = await db.query<{ total: string }>(
      `select count(*)::text total from leads where campaign_id = $1`, [campaignId])
    const campaignTotal = Number(totals?.total ?? 0)

    ctx.cost.detail = {
      batchIndex, cities: batchCities.length, queries: queries.length,
      returned: raw.length, kept: inserted, dropped, drops,
      campaignTotal, bytes: wait.bytes,
      depth: mapsDepth(),
      residential_mb: meter ? Number((meter.totalBytes / 1e6).toFixed(3)) : null,
      mb_per_business: meter && inserted
        ? Number((meter.totalBytes / 1e6 / inserted).toFixed(3)) : null,
      meter_blocked: meter?.blocked ?? null,
      meter_top_hosts: meter?.topHosts?.slice(0, 5) ?? null,
    }
    ctx.logger.info('maps discovery batch complete', ctx.cost.detail)

    await db.query(
      `update campaigns
          set step1_done = $2,
              stat_dropped_step1 = coalesce(stat_dropped_step1,0) + $3,
              current_step = 2
        where id = $1`,
      [campaignId, campaignTotal, dropped])

    // ── next batch, or finish ────────────────────────────────────────────────
    //
    // Sequential: the next batch is only queued once this one is written. Two
    // concurrent 36-query scrapes would recreate exactly the overload the batch
    // size exists to avoid.
    if (moreBatches && campaignTotal < targetCount) {
      await ctx.helpers.addJob('maps:discover',
        { ...payload, batchIndex: batchIndex + 1 },
        { jobKey: jobKey(`maps:discover:${batchIndex + 1}`, campaignId), maxAttempts: 2 })
      ctx.logger.info('queued next discovery batch', {
        next: batchIndex + 1, campaignTotal, targetCount,
      })
    } else {
      ctx.logger.info('discovery finished', {
        reason: campaignTotal >= targetCount ? 'target reached' : 'cities exhausted',
        campaignTotal, targetCount,
      })
    }

    await finishDiscovery(ctx, db, campaignId)
  })
}

/**
 * Seed the reconcile loop.
 *
 * Called from every exit path, including the empty-batch one — a campaign whose
 * discovery produced nothing still has to reach a terminal state rather than
 * sit in `running` forever, which is the v1 failure this whole architecture
 * exists to avoid.
 */
async function finishDiscovery(
  ctx: JobContext, db: TaskDeps['db'], campaignId: string,
): Promise<void> {
  await ctx.helpers.addJob('campaign:reconcile', { campaignId },
    { jobKey: jobKey('campaign:reconcile', campaignId), runAt: new Date(Date.now() + 60_000) })
}

/**
 * Ceiling on queries per discovery job.
 *
 * gosom degrades badly past a few dozen concurrent Maps searches — the
 * statewide wrap run logged 71 `target closed` and a run of 403/502s and
 * returned 8 rows, while 2 queries against the same cities returned 9. Capping
 * trades breadth for a scrape that actually completes.
 */
export function maxQueries(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MAPS_MAX_QUERIES ?? '')
  return Number.isFinite(n) && n > 0 ? n : 36
}

/** Floor, ceiling and per-query allowance for the discovery wait. */
export const MAPS_WAIT_MIN_MS = 20 * 60_000
export const MAPS_WAIT_MAX_MS = 45 * 60_000
export const MAPS_WAIT_PER_QUERY_MS = 30_000

/**
 * How long to wait for a scrape of `queryCount` cities.
 *
 * `MAPS_WAIT_MINUTES` overrides everything — including the ceiling — because an
 * operator setting it explicitly knows more than this heuristic does.
 */
export function mapsWaitMs(
  queryCount: number, env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.MAPS_WAIT_MINUTES ?? '')
  if (Number.isFinite(override) && override > 0) return override * 60_000
  const scaled = queryCount * MAPS_WAIT_PER_QUERY_MS
  return Math.min(MAPS_WAIT_MAX_MS, Math.max(MAPS_WAIT_MIN_MS, scaled))
}

/** Proxy URLs handed to the scraper subprocess, which cannot use ProxyPool. */
/**
 * Proxy URLs for the scraper.
 *
 * Chromium — which is what gosom drives — does not accept credentials embedded
 * in a `--proxy-server` URL. Handing it `http://user:pass@host:port` produced
 * 498 ERR_PROXY_AUTH_UNSUPPORTED and "Upstream proxy rejected CONNECT: 522",
 * so Maps discovery never egressed residential at all.
 *
 * MAPS_PROXY_URL points at the local auth-forwarding hop (the `decodo-proxy`
 * container), which is credential-free from Chromium's side and attaches the
 * Decodo credentials upstream. The direct URLs remain the fallback for when
 * that container is not running, so this degrades to the old behaviour rather
 * than to no proxy at all.
 */
function residentialProxyUrls(config: TaskDeps['config']): string[] {
  // proxy-meter first. It attaches the real Decodo credentials upstream, so
  // the URL handed to gosom carries placeholder ones — gosom's internal
  // AuthProxy *requires* a user:pass in the URL and refuses to start without,
  // which is what broke the earlier credential-free forwarder.
  const meter = (process.env.MAPS_PROXY_METER_URL ?? '').trim()
  if (meter) {
    const u = new URL(meter)
    if (!u.username) { u.username = 'meter'; u.password = 'meter' }
    return [u.toString().replace(/\/$/, '')]
  }

  const forwarder = (process.env.MAPS_PROXY_URL ?? '').trim()
  if (forwarder) return [forwarder]

  const { username, password, host, country, rotatingPort, stickyPortMin } = config.decodo
  if (!username || !password || !host) return []
  const user = country ? `user-${username}-country-${country}` : username
  // A handful of distinct exits so one blocked IP does not stall the scrape.
  const ports = [rotatingPort, stickyPortMin, stickyPortMin + 1, stickyPortMin + 2]
  return ports.map(p => `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${p}`)
}

/**
 * Verify and log the proxy's exit IP before a scrape starts.
 *
 * Throws when the exit is outside the required country. That is deliberately
 * fatal: a scrape through the wrong geography does not fail, it succeeds with
 * the wrong data, and a campaign of Argentine med spas labelled "Long Island,
 * NY" is worse than no campaign at all.
 *
 * A lookup that cannot run at all is only a warning — failing the whole job
 * because an IP-geolocation service is down would trade a silent-data problem
 * for a loud-availability one.
 */
export async function assertProxyExit(
  proxyUrl: string | undefined,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const required = (process.env.MAPS_PROXY_REQUIRE_COUNTRY ?? '').trim().toUpperCase()
  if (!proxyUrl) {
    logger.warn('maps scrape has no proxy configured — egressing from the server IP')
    return
  }

  let info: { ip?: string; city?: string; region?: string; country?: string; org?: string }
  try {
    const { ProxyAgent } = await import('undici')
    const res = await fetchThroughProxy(proxyUrl, ProxyAgent)
    info = res
  } catch (err) {
    logger.warn('could not confirm proxy exit IP — proceeding unverified', {
      error: (err as Error).message,
    })
    return
  }

  logger.info('maps proxy exit IP', {
    ip: info.ip, city: info.city, region: info.region,
    country: info.country, org: info.org,
  })

  if (required && (info.country ?? '').toUpperCase() !== required) {
    throw new Error(
      `maps proxy exit is ${info.country ?? 'unknown'} (${info.ip ?? '?'}, ` +
      `${info.city ?? '?'}) but ${required} is required. Google localises by exit IP, ` +
      'so this scrape would return results for the wrong country. A sticky port ' +
      'holds its session until the TTL expires — switch DECODO_MAPS_STICKY_PORT ' +
      'to a port without a live session.')
  }
}

async function fetchThroughProxy(
  proxyUrl: string, ProxyAgent: typeof import('undici').ProxyAgent,
): Promise<Record<string, string>> {
  const agent = new ProxyAgent(proxyUrl)
  try {
    const { fetch: undiciFetch } = await import('undici')
    const res = await undiciFetch('https://ipinfo.io/json', {
      dispatcher: agent,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`ipinfo HTTP ${res.status}`)
    return await res.json() as Record<string, string>
  } finally {
    await agent.close().catch(() => {})
  }
}

/**
 * Scroll depth per query.
 *
 * Was 10 — ten pages of scrolling per city. The filters keep roughly three
 * businesses per query, so most of those pages were fetched, rendered and
 * discarded. Residential bytes scale with depth almost linearly, so this is
 * the largest single lever on cost after blocking.
 */
export function mapsDepth(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MAPS_DEPTH ?? '')
  return Number.isFinite(n) && n > 0 ? n : 5
}

interface MeterReading {
  totalBytes: number
  blocked: number
  topHosts: Array<{ host: string; mb: number; n: number }>
}

function meterBase(): string {
  return (process.env.MAPS_PROXY_METER_URL ?? '').trim().replace(/\/$/, '')
}

/** Zero the meter so a batch's reading belongs to that batch alone. */
async function resetMeter(logger: Pick<Logger, 'warn'>): Promise<void> {
  const base = meterBase()
  if (!base) return
  try {
    await httpFetch(new URL('/meter/reset', base), {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    // Losing the measurement must not lose the scrape.
    logger.warn('could not reset proxy meter', { err: (err as Error).message })
  }
}

async function readMeter(logger: Pick<Logger, 'warn'>): Promise<MeterReading | null> {
  const base = meterBase()
  if (!base) return null
  try {
    const res = await httpFetch(new URL('/metrics', base), {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return await res.json() as MeterReading
  } catch (err) {
    logger.warn('could not read proxy meter', { err: (err as Error).message })
    return null
  }
}
