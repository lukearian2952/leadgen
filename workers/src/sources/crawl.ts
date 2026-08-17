// Site crawl: home + the pages that name people.
//
// ── Proxy policy (your Phase 2 instruction) ──────────────────────────────────
// Crawling goes out on the DATACENTER pool by default and only retries through
// residential on 403 / 429 / captcha. Most small-business sites do not care
// where the request comes from, and residential GB is the dominant variable
// cost — spending it on every homepage would blow the $0.02/business target on
// its own. Per-stage proxy bytes are reported separately so the split is
// visible rather than assumed.
//
// Direct fetch is used rather than crawl4ai's browser for the first attempt:
// these are brochure sites, and rendering JS for a page whose team list is in
// the HTML is a 20x cost multiplier. crawl4ai is the escalation for pages that
// come back empty.

import type { ProxyPool, PoolName } from '../proxy/pool.js'
import type { Logger } from '../logger.js'

const PAGE_CAP = 6
const MAX_BYTES = 2_000_000
const MAX_TEXT = 24_000

/** Paths worth trying when the homepage exposes no obvious people link. */
const FALLBACK_PATHS = [
  '/about', '/about-us', '/team', '/our-team', '/meet-the-team',
  '/staff', '/our-story', '/founder', '/providers', '/doctors', '/contact',
]

const PEOPLE_LINK_RE =
  /about|team|staff|founder|our[-_ ]?story|provider|doctor|practitioner|meet[-_ ]|contact/i

/** Responses that mean "come back as a residential user". */
const BLOCKED_STATUSES = new Set([401, 403, 406, 409, 429, 503])
const CAPTCHA_RE = /captcha|are you a robot|cf-challenge|cloudflare|just a moment|access denied|attention required/i

export interface CrawledPage {
  url: string
  html: string
  text: string
  bytes: number
  pool: PoolName
  status: number
}

export interface CrawlResult {
  pages: CrawledPage[]
  text: string
  /** mailto: and regex-scraped addresses, deduped, lowercased. */
  emails: string[]
  /** Bytes per pool, for the cost split. */
  bytesByPool: Record<string, number>
  /** True when we had to escalate to residential. */
  escalated: boolean
  error?: string
}

const EMPTY = (): CrawlResult =>
  ({ pages: [], text: '', emails: [], bytesByPool: {}, escalated: false })

export class CrawlSource {
  readonly name = 'site_crawl'

  constructor(
    private readonly pool: ProxyPool,
    private readonly logger: Logger,
    /** Passed to ProxyPool so residential bytes count against the campaign's
     *  budget. Without it the crawl spends unmetered. */
    private readonly campaignId?: string,
  ) {}

  /**
   * Fetch one page, datacenter first, residential on a blocking signal.
   *
   * The sticky session key is the hostname, so every page of one site exits
   * from the same residential IP when we do escalate — a site that sees three
   * different IPs mid-crawl is more suspicious than one that sees a datacenter.
   */
  private async fetchPage(
    url: string, host: string,
  ): Promise<{ page: CrawledPage | null; escalated: boolean }> {
    const attempts: Array<{ pool: PoolName; session?: string }> = [
      { pool: 'datacenter' },
      { pool: 'decodo_residential', session: host },
    ]

    let escalated = false
    for (const [i, attempt] of attempts.entries()) {
      if (i > 0) escalated = true
      try {
        const res = await this.pool.fetch(url, {
          ...attempt,
          campaignId: this.campaignId,
          timeoutMs: 20_000,
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        })

        const type = res.response.headers.get('content-type') ?? ''
        const body = type.includes('html') || type === ''
          ? (await res.response.text()).slice(0, MAX_BYTES)
          : ''

        const blocked = BLOCKED_STATUSES.has(res.response.status) ||
                        (body.length < 4000 && CAPTCHA_RE.test(body))

        if (blocked && i < attempts.length - 1) {
          this.logger.debug('crawl blocked on datacenter, escalating to residential', {
            url, status: res.response.status,
          })
          continue
        }
        if (!res.response.ok || !body) {
          return { page: null, escalated }
        }

        return {
          page: {
            url, html: body, text: htmlToText(body),
            bytes: res.bytes, pool: res.pool, status: res.response.status,
          },
          escalated,
        }
      } catch {
        if (i < attempts.length - 1) continue
        return { page: null, escalated }
      }
    }
    return { page: null, escalated }
  }

  async crawl(website: string): Promise<CrawlResult> {
    let base: URL
    try {
      base = new URL(website.startsWith('http') ? website : `https://${website}`)
    } catch {
      return { ...EMPTY(), error: 'unparseable website' }
    }

    const host = base.hostname.replace(/^www\./, '')
    const result = EMPTY()

    const home = await this.fetchPage(base.href, host)
    result.escalated = home.escalated
    if (!home.page) return { ...result, error: 'homepage unreachable' }

    const record = (page: CrawledPage) => {
      result.pages.push(page)
      result.bytesByPool[page.pool] = (result.bytesByPool[page.pool] ?? 0) + page.bytes
    }
    record(home.page)

    // Link discovery first, blind paths only to fill the budget — same cost,
    // better hit rate on sites using /our-practice or /meet-dr-smith.
    const candidates = discoverPeopleLinks(home.page.html, base)
    for (const path of FALLBACK_PATHS) {
      if (candidates.length >= PAGE_CAP * 2) break
      try {
        const url = new URL(path, base).href
        if (!candidates.includes(url)) candidates.push(url)
      } catch { /* skip */ }
    }

    const seen = new Set([base.href])
    for (const url of candidates) {
      if (result.pages.length >= PAGE_CAP) break
      if (seen.has(url)) continue
      seen.add(url)
      const got = await this.fetchPage(url, host)
      if (got.escalated) result.escalated = true
      if (got.page) record(got.page)
    }

    result.text = result.pages.map(p => p.text).join('\n\n').slice(0, MAX_TEXT)
    result.emails = extractEmails(result.pages.map(p => p.html).join('\n'), host)
    return result
  }
}

// ── extraction ───────────────────────────────────────────────────────────────

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
/** Asset filenames match the email shape; excluding them is not optional. */
const NOT_EMAIL_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i

/**
 * Percent-decode and strip whitespace from a scraped address.
 *
 * Both scrape passes use this so an address written one way in `mailto:` and
 * another in the surrounding text collapses to a single entry. Malformed
 * escapes are left as-is rather than thrown — a bad href must not kill a crawl.
 */
function normaliseScrapedEmail(raw: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { decoded = raw }
  return decoded.replace(/\s+/g, '').toLowerCase()
}

export function extractEmails(html: string, preferHost?: string): string[] {
  const found = new Set<string>()

  for (const m of html.matchAll(/mailto:([^"'>?\s]+)/gi)) {
    // `decodeURIComponent` turns `%20` into a real space, which `.trim()` then
    // only removes from the ends — `mailto:%20info@x.com` came through as
    // " info@x.com" and was stored with the space intact. That address then
    // reads as a *personal* local part rather than the role inbox it is, which
    // matters now that the on-domain-personal count is a reported metric.
    // decodeURIComponent can also throw on a malformed escape.
    const e = normaliseScrapedEmail(m[1])
    if (e.includes('@') && !NOT_EMAIL_RE.test(e)) found.add(e)
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    // EMAIL_RE allows `%` in a local part, so the *encoded* form of an address
    // already captured above matches here too — `mailto:%20info@x.com` yielded
    // both `info@x.com` and `info%20@x.com`. Normalising identically lets the
    // Set collapse them instead of reporting one address as two.
    const e = normaliseScrapedEmail(m[0])
    if (!NOT_EMAIL_RE.test(e)) found.add(e)
  }

  const all = [...found].filter(e => e.length <= 100)
  if (!preferHost) return all
  // Addresses on the business's own domain first — a Wix support address that
  // happens to appear in a template is not a lead.
  const root = preferHost.split('.').slice(-2).join('.')
  return [
    ...all.filter(e => e.endsWith(`@${preferHost}`) || e.endsWith(`.${root}`) || e.endsWith(`@${root}`)),
    ...all.filter(e => !(e.endsWith(`@${preferHost}`) || e.endsWith(`.${root}`) || e.endsWith(`@${root}`))),
  ]
}

function discoverPeopleLinks(html: string, base: URL): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = anchor.exec(html)) !== null) {
    const href = m[1]
    const label = m[2].replace(/<[^>]+>/g, ' ')
    if (!PEOPLE_LINK_RE.test(href) && !PEOPLE_LINK_RE.test(label)) continue
    try {
      const url = new URL(href, base)
      if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue
      url.hash = ''
      if (seen.has(url.href)) continue
      seen.add(url.href)
      out.push(url.href)
    } catch { /* skip */ }
    if (out.length >= 10) break
  }
  return out
}

/**
 * Does this name actually appear in the site's own text?
 *
 * The corroboration gate for a model-proposed name. Without it the model will
 * invent a plausible owner for any business, and "Hi {hallucinated}," is the
 * exact failure this pipeline exists to prevent.
 */
export function nameAppearsInText(first: string, last: string, text: string): boolean {
  if (!first) return false
  const haystack = text.toLowerCase()
  const f = first.toLowerCase()
  const l = (last ?? '').toLowerCase()
  const word = (needle: string) =>
    new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')
      .test(haystack)
  if (l) return word(`${f} ${l}`) || (word(f) && word(l))
  return word(f)
}
