// A very small site crawler for the owner-lookup stage.
//
// Deliberately not an Apify actor: we need three pages from one domain, and
// paying actor-run overhead per lead to fetch an /about page is absurd. Hard
// caps everywhere — this runs inside an edge function with a wall clock.

const PAGE_CAP = 3          // total pages fetched per lead, homepage included
const FETCH_TIMEOUT = 8000
const MAX_BYTES = 400_000   // stop reading absurd pages
const MAX_TEXT = 12_000     // characters of extracted text handed to the model

/** Paths worth trying when the homepage exposes no obvious team link. */
const FALLBACK_PATHS = [
  '/about', '/about-us', '/team', '/our-team', '/meet-the-team',
  '/staff', '/our-story', '/founder', '/providers', '/doctors',
]

/** Link text / hrefs that suggest a page naming the people behind the business. */
const PEOPLE_LINK_RE = /about|team|staff|founder|our[-_ ]?story|provider|doctor|practitioner|meet[-_ ]/i

export interface CrawlResult {
  /** Concatenated, tag-stripped text from every page fetched. */
  text: string
  /** First substantial paragraph of the homepage — used by the fallback stage. */
  firstParagraph: string
  pagesFetched: number
  urls: string[]
}

const EMPTY: CrawlResult = { text: '', firstParagraph: '', pagesFetched: 0, urls: [] }

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        // Some small-business hosts return 403 to an unadorned fetch.
        'User-Agent': 'Mozilla/5.0 (compatible; LeadGenBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('html')) return null

    const buf = await res.arrayBuffer()
    const slice = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf
    return new TextDecoder('utf-8', { fatal: false }).decode(slice)
  } catch {
    return null
  }
}

/** Strip scripts, styles and tags. Crude, but the model only needs prose. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep block boundaries so names and titles don't run together.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function firstParagraphOf(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length >= 80) return t.slice(0, 600)
  }
  return text.slice(0, 300)
}

/** Same-origin links whose text or href looks like a people page. */
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
      const key = url.href
      if (seen.has(key)) continue
      seen.add(key)
      out.push(key)
    } catch { /* skip unparseable href */ }
    if (out.length >= 6) break
  }
  return out
}

/**
 * Fetch the homepage plus up to two pages that look like they name people.
 * Link discovery first, blind path guessing only as a fallback — same budget,
 * better hit rate on sites that use /our-practice or /meet-dr-smith.
 */
export async function crawlForPeople(website: string): Promise<CrawlResult> {
  let base: URL
  try {
    base = new URL(website.startsWith('http') ? website : `https://${website}`)
  } catch {
    return EMPTY
  }

  const home = await fetchPage(base.href)
  if (!home) return EMPTY

  const homeText = htmlToText(home)
  const parts = [homeText]
  const urls = [base.href]

  const candidates = discoverPeopleLinks(home, base)
  if (candidates.length < PAGE_CAP - 1) {
    for (const path of FALLBACK_PATHS) {
      try {
        const url = new URL(path, base).href
        if (!candidates.includes(url)) candidates.push(url)
      } catch { /* skip */ }
      if (candidates.length >= 8) break
    }
  }

  for (const url of candidates) {
    if (urls.length >= PAGE_CAP) break
    if (urls.includes(url)) continue
    const html = await fetchPage(url)
    if (!html) continue
    urls.push(url)
    parts.push(htmlToText(html))
  }

  const text = parts.join('\n\n').slice(0, MAX_TEXT)
  return {
    text,
    firstParagraph: firstParagraphOf(homeText),
    pagesFetched: urls.length,
    urls,
  }
}

/**
 * Does this name actually appear in the site's own text?
 *
 * Gate for the model-proposed-owner fallback: a name the model produced but
 * the site never mentions is a hallucination, and "Hi {hallucinated}," is
 * exactly the failure the rework exists to stop.
 */
export function nameAppearsInText(first: string, last: string, text: string): boolean {
  if (!first) return false
  const haystack = text.toLowerCase()
  const f = first.toLowerCase()
  const l = (last ?? '').toLowerCase()

  const wordBoundary = (needle: string) =>
    new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(haystack)

  if (l) return wordBoundary(`${f} ${l}`) || (wordBoundary(f) && wordBoundary(l))
  return wordBoundary(f)
}
