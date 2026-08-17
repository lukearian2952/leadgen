// Google Maps discovery via self-hosted gosom/google-maps-scraper.
//
// Replaces v1's Places Text Search + Place Details, which cost ~$0.057 per
// business in API fees. This costs proxy bytes and CPU.
//
// The scraper runs as a long-lived web service; we POST a job, poll for status,
// and pull a CSV. Its output is richer than Place Details was — it carries
// category, review count, lat/lon, a complete address, and sometimes scraped
// emails and an owner name straight off the listing.
//
// Maps always egresses residential: Google localises results by exit IP, and a
// datacenter IP either gets blocked or silently returns a different result set.

import { httpFetch } from '../net.js'
import type { Logger } from '../logger.js'

export interface MapsBusiness {
  name: string
  category: string
  website: string
  phone: string
  address: string
  street: string
  city: string
  state: string
  postalCode: string
  country: string
  placeId: string
  latitude: number | null
  longitude: number | null
  rating: number | null
  reviewCount: number
  /** Emails the scraper found on the listing/site. Never owner-grade. */
  emails: string[]
  /** Owner string when Google exposes one. Unverified. */
  owner: string
  link: string
}

interface JobStatus {
  ID: string
  Name: string
  Status: string   // pending | working | ok | failed
}

export class MapsSource {
  readonly name = 'google_maps'

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Start a scrape. `proxies` is passed through to the scraper so its own
   * browser egresses residential — our ProxyPool cannot wrap a subprocess.
   */
  async startJob(
    jobName: string, queries: string[], proxies: string[], opts: {
      lang?: string; zoom?: number; depth?: number; maxSeconds?: number
    } = {},
  ): Promise<string> {
    const body = {
      name: jobName,
      keywords: queries,
      lang: opts.lang ?? 'en',
      zoom: opts.zoom ?? 14,
      depth: opts.depth ?? 10,
      // The API takes nanoseconds.
      max_time: (opts.maxSeconds ?? 900) * 1_000_000_000,
      email: true,
      proxies: proxies.length ? proxies : null,
    }

    const res = await httpFetch(new URL('/api/v1/jobs', this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status !== 201 && !res.ok) {
      throw new Error(`maps-scraper POST /jobs -> HTTP ${res.status}`)
    }
    const json = await res.json() as { id?: string }
    if (!json.id) throw new Error('maps-scraper returned no job id')
    this.logger.info('maps job started', { jobId: json.id, queries: queries.length })
    return json.id
  }

  async status(jobId: string): Promise<string> {
    const res = await httpFetch(new URL('/api/v1/jobs', this.baseUrl), {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`maps-scraper GET /jobs -> HTTP ${res.status}`)
    const jobs = await res.json() as JobStatus[]
    return jobs.find(j => j.ID === jobId)?.Status ?? 'unknown'
  }

  /** Poll to completion. Returns the terminal status. */
  /**
   * Poll to completion, requiring an actual payload.
   *
   * `status` is not sufficient on its own. gosom flips a job to `ok` while it is
   * still scraping, and `/download` returns 0 bytes at that moment — so the
   * previous version returned `ok`, downloaded nothing, and reported
   * `returned: 0` for a run that had in fact found the right businesses. The
   * status is a necessary condition, never a sufficient one.
   *
   * So: `ok` only ends the wait once the download is non-empty. `failed` ends it
   * immediately — there is nothing to wait for. Everything else keeps polling to
   * the cap.
   */
  async waitFor(jobId: string, maxMs: number, pollMs = 10_000): Promise<MapsWaitResult> {
    const deadline = Date.now() + maxMs
    let last = ''
    let sawOkButEmpty = false
    let previousBytes = -1

    while (Date.now() < deadline) {
      last = await this.status(jobId)

      if (last === 'failed') return { status: 'failed', bytes: 0, okButEmptyPolls: 0 }

      if (last === 'ok') {
        const body = await this.rawResults(jobId)

        if (body.trim().length === 0) {
          // Reported complete with nothing to show for it: keep waiting.
          sawOkButEmpty = true
        } else if (body.length === previousBytes) {
          // Non-empty AND unchanged since the previous poll. Status alone is not
          // enough and neither is non-emptiness: measured on a real run, the
          // worker read 1,038,254 bytes from a job already reporting `ok` and
          // the file was 1,043,361 a minute later. The status flips while the
          // scraper is still writing, so a size that has stopped moving is the
          // only available evidence the write finished.
          return { status: 'ok', bytes: body.length, okButEmptyPolls: 0, body }
        } else {
          previousBytes = body.length
        }
      }

      await new Promise(r => setTimeout(r, pollMs))
    }

    // Distinguish "never finished" from "claimed to finish but produced
    // nothing" — they need different responses and the old code conflated them.
    return {
      status: sawOkButEmpty ? 'ok_but_empty' : (last ? 'timeout' : 'unknown'),
      bytes: 0,
      okButEmptyPolls: sawOkButEmpty ? 1 : 0,
    }
  }

  /** The raw CSV body, or '' when the scraper has nothing yet. */
  async rawResults(jobId: string): Promise<string> {
    const res = await httpFetch(
      new URL(`/api/v1/jobs/${jobId}/download`, this.baseUrl),
      { signal: AbortSignal.timeout(120_000) },
    )
    // A not-yet-ready download is an expected state during polling, not an
    // error: treat it as empty and let the caller keep waiting.
    if (res.status === 404 || res.status === 204) return ''
    if (!res.ok) throw new Error(`maps-scraper download -> HTTP ${res.status}`)
    return await res.text()
  }

  async results(jobId: string): Promise<MapsBusiness[]> {
    return parseCsv(await this.rawResults(jobId))
  }
}

/** Outcome of waiting on a scrape job. */
export interface MapsWaitResult {
  /**
   * ok            — finished with a non-empty payload
   * failed        — the scraper reported failure
   * ok_but_empty  — reported complete, still empty when the cap expired
   * timeout       — never reported complete
   */
  status: 'ok' | 'failed' | 'ok_but_empty' | 'timeout' | 'unknown'
  bytes: number
  okButEmptyPolls: number
  /** Carried through so a successful wait does not re-download. */
  body?: string
}

// ── CSV ──────────────────────────────────────────────────────────────────────
//
// Hand-rolled rather than a dependency: the scraper emits RFC4180 with embedded
// JSON in several columns, so the only real requirement is correct handling of
// quoted fields containing commas, quotes and newlines.

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.length > 1 || (r[0] ?? '').trim() !== '')
}

/**
 * Split "630 Old Country Rd, Garden City, NY 11530, United States".
 *
 * Parsed from the tail so a street containing commas does not shift the state.
 */
export function parseAddress(address: string): {
  street: string; city: string; state: string; postalCode: string; country: string
} {
  const empty = { street: '', city: '', state: '', postalCode: '', country: '' }
  if (!address) return empty

  let parts = address.split(',').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return empty

  let country = ''
  if (parts.length > 1 && /^(united states|usa|us|canada)$/i.test(parts[parts.length - 1])) {
    country = /canada/i.test(parts.pop()!) ? 'CA' : 'US'
  }

  let state = ''
  let postalCode = ''
  const tail = parts[parts.length - 1] ?? ''
  const m = tail.match(/^([A-Z]{2})\s+([\d]{5}(?:-\d{4})?)$/)
             ?? tail.match(/^([A-Z]{2})$/)
  if (m) {
    state = m[1]
    postalCode = m[2] ?? ''
    parts.pop()
    if (!country) country = 'US'
  }

  const city = parts.length ? parts.pop()!.trim() : ''
  return { street: parts.join(', '), city, state, postalCode, country }
}

function splitEmails(raw: string): string[] {
  if (!raw) return []
  const cleaned = raw.trim().replace(/^\[|\]$/g, '')
  return cleaned
    .split(/[,;\s]+/)
    .map(e => e.replace(/^["']|["']$/g, '').trim().toLowerCase())
    .filter(e => e.includes('@'))
}

export function parseCsv(text: string): MapsBusiness[] {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return []

  const header = rows[0].map(h => h.trim())
  const idx = (name: string) => header.indexOf(name)
  const col = {
    title: idx('title'), category: idx('category'), address: idx('address'),
    website: idx('website'), phone: idx('phone'), placeId: idx('place_id'),
    lat: idx('latitude'), lon: idx('longitude'),
    rating: idx('review_rating'), reviews: idx('review_count'),
    emails: idx('emails'), owner: idx('owner'), link: idx('link'),
    complete: idx('complete_address'),
  }

  const out: MapsBusiness[] = []
  for (const row of rows.slice(1)) {
    const get = (i: number) => (i >= 0 && i < row.length ? (row[i] ?? '').trim() : '')
    const name = get(col.title)
    if (!name) continue

    const address = get(col.address)
    const parsed = parseAddress(address)

    out.push({
      name,
      category: get(col.category),
      website: get(col.website),
      phone: get(col.phone),
      address,
      ...parsed,
      placeId: get(col.placeId),
      latitude: numOrNull(get(col.lat)),
      longitude: numOrNull(get(col.lon)),
      rating: numOrNull(get(col.rating)),
      reviewCount: Number.parseInt(get(col.reviews) || '0', 10) || 0,
      emails: splitEmails(get(col.emails)),
      owner: get(col.owner),
      link: get(col.link),
    })
  }
  return out
}

function numOrNull(s: string): number | null {
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
