// SaaS / online-business discovery from search results.
//
// ── Why this is not a G2 / Capterra / ProductHunt / YC crawler ───────────────
//
// All four were checked live on 2026-08-26, from this machine and again through
// residential, before any of this was written:
//
//   g2.com          robots.txt *permits* the category pages — 403, Cloudflare
//                   managed challenge, residential included
//   capterra.com    same: robots permits, Cloudflare challenges
//   producthunt.com Cloudflare challenge on every path, `robots.txt` included
//   api.ycombinator.com  200 and richly structured, but `robots.txt` is
//                   `Disallow: /` for every agent
//
// So two of them would require defeating a JS challenge, which is
// circumventing an access control rather than crawling, and the one that
// answers cleanly asks in its robots file not to be read by machines. None is
// implemented. `docs/DECISIONS.md` records this in full.
//
// Search is the remaining channel, and it is also the one the architecture
// already nominates: `resolveNicheFilter` turns SERP *on* for any niche that
// matches no brick-and-mortar rule, which is exactly the online/SaaS case.
//
// ── What actually comes back ────────────────────────────────────────────────
//
// One query, `"practice management software" pricing`, returned 39 results
// across three engines and about twenty real vendor domains — simplepractice,
// practicepanther, archy, rocketmatter, omnimd, centerbase, zandahealth and
// more. It also returned eight dictionary sites, because "practice" and
// "management" are English words, and four review aggregators. Hence
// `DIRECTORY_DOMAINS` and `REFERENCE_DOMAINS` below: on this query shape the
// junk is not incidental, it is roughly a third of the result set.

import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import type { SerpProvider } from './serp-provider.js'
import { SerpSource, type SerpResult } from './serp.js'
import { extractDomain, isJunkDomain } from '../lib/identity.js'

/**
 * Review aggregators, marketplaces and directories.
 *
 * These rank *above* the vendors for every buying-intent query, because that
 * is their whole business. They are not leads: nobody at capterra.com owns the
 * software we are looking for.
 */
export const DIRECTORY_DOMAINS = new Set([
  'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com', 'trustradius.com',
  'goodfirms.co', 'sourceforge.net', 'slashdot.org', 'saashub.com', 'alternativeto.net',
  'producthunt.com', 'crunchbase.com', 'pitchbook.com', 'owler.com', 'zoominfo.com',
  'clutch.co', 'techradar.com', 'pcmag.com', 'cnet.com', 'zdnet.com',
  'gartner.com', 'forrester.com', 'klasresearch.com', 'trustpilot.com',
  'softwaresuggest.com', 'financesonline.com', 'selecthub.com', 'comparecamp.com',
  'appsumo.com', 'producthunt.net', 'betalist.com', 'saasworthy.com',
  'ycombinator.com', 'angel.co', 'wellfound.com', 'priceithere.com',
])

/**
 * Dictionaries, encyclopaedias, forums and news.
 *
 * A niche phrase made of ordinary English words — "practice management
 * software" — pulls definition sites into every engine's results. Measured:
 * eight of 36 hosts on one query.
 */
export const REFERENCE_DOMAINS = new Set([
  'merriam-webster.com', 'dictionary.com', 'dictionary.cambridge.org',
  'thefreedictionary.com', 'vocabulary.com', 'wordreference.com',
  'grammar-monster.com', 'collinsdictionary.com', 'britannica.com', 'keybr.com',
  'wikipedia.org', 'wiktionary.org', 'wikidata.org', 'quora.com', 'reddit.com',
  'medium.com', 'substack.com', 'youtube.com', 'vimeo.com', 'facebook.com',
  'linkedin.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
  'pinterest.com', 'github.com', 'stackoverflow.com', 'glassdoor.com',
  'indeed.com', 'ziprecruiter.com', 'forbes.com', 'techcrunch.com',
  'businessinsider.com', 'nytimes.com', 'bloomberg.com', 'amazon.com',
  'apple.com', 'microsoft.com', 'google.com', 'bestbuy.com',
])

/**
 * Does this look like a hostname at all?
 *
 * `extractDomain` falls back to string-munging when `new URL` throws, so a
 * malformed result URL comes back as the input rather than as empty — `"not a
 * url"` would otherwise be stored as a lead's domain, spaces and all. Search
 * results are third-party text; validate before trusting.
 */
export function isHostname(value: string): boolean {
  const d = (value ?? '').trim().toLowerCase()
  if (d.length < 4 || d.length > 253) return false
  // Labels of letters/digits/hyphens, at least one dot, and a TLD of 2+ letters.
  return /^(?!-)[a-z0-9-]+(?<!-)(\.(?!-)[a-z0-9-]+(?<!-))*\.[a-z]{2,}$/.test(d)
}

/** True for a host we would never want as a lead. */
export function isExcludedHost(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '')
  if (isJunkDomain(d)) return true
  for (const set of [DIRECTORY_DOMAINS, REFERENCE_DOMAINS]) {
    if (set.has(d)) return true
    for (const j of set) if (d.endsWith(`.${j}`)) return true
  }
  // Government, academic and military sites are not SaaS vendors.
  if (/\.(gov|mil|edu)$/.test(d)) return true
  return false
}

/**
 * The category words a product niche is written with, and which are
 * interchangeable in practice.
 *
 * Measured: `"practice management SaaS"` across five query shapes returned 49
 * unique vendors against a target of 100, because almost nobody describes their
 * own product as "SaaS" — they say *software*, *platform* or *system*. The word
 * a buyer types and the word a vendor prints on its own homepage are different
 * words, and searching only the former finds mostly people writing *about* the
 * category.
 */
const CATEGORY_WORDS = ['saas', 'software', 'platform', 'system', 'tool', 'app']

/**
 * A niche phrase plus its category-word variants.
 *
 * `practice management SaaS` becomes `practice management software`,
 * `… platform`, `… system`. A niche with no category word is returned as-is —
 * inventing suffixes for "dental implants" would search for something nobody
 * writes.
 */
export function nichePhrases(niche: string): string[] {
  const phrase = (niche ?? '').replace(/["]/g, '').trim()
  if (!phrase) return []

  const words = phrase.split(/\s+/)
  const lastIndex = words.length - 1
  const last = (words[lastIndex] ?? '').toLowerCase()
  if (!CATEGORY_WORDS.includes(last)) return [phrase]

  const stem = words.slice(0, lastIndex).join(' ')
  if (!stem) return [phrase]

  // The niche's own wording first: it is what the caller asked for, and the
  // ordering decides which variant fills the target when the cap bites.
  const ordered = [last, ...CATEGORY_WORDS.filter(w => w !== last)]
  return ordered.map(w => `${stem} ${w}`)
}

/**
 * Query shapes for a SaaS niche.
 *
 * Every one of these carries **buying intent** rather than description, which
 * is what separates a vendor's own site from an article about the category.
 * "pricing", "free trial" and "request a demo" appear on a vendor's own pages
 * and essentially nowhere else; a listicle says "best X software" instead,
 * which is why that phrasing is deliberately absent — tried first, it returned
 * mostly definitions of the word "best".
 */
export function saasQueries(niche: string, location = '', maxPhrases = 3): string[] {
  const where = (location ?? '').trim().toLowerCase()
  // "United States" as a search term pulls in directories of US companies
  // rather than narrowing to US vendors, so it is only used when the location
  // is more specific than a whole country.
  const geo = where && !/^(united states|usa|us|worldwide|global)$/.test(where)
    ? ` ${location}` : ''

  // Intent suffixes. Each appears on a vendor's own pages and essentially
  // nowhere else; a listicle says "best X software" instead, which is why that
  // phrasing is absent — tried first, it returned mostly definitions of the
  // word "best".
  const intents = [
    'pricing',
    '"request a demo"',
    '"free trial"',
    '"start your free trial" OR "book a demo"',
    'platform for',
  ]

  const phrases = nichePhrases(niche).slice(0, Math.max(1, maxPhrases))
  const queries: string[] = []
  for (const phrase of phrases) {
    for (const intent of intents) queries.push(`"${phrase}" ${intent}${geo}`)
  }
  return queries
}

export interface SaasCandidate {
  domain: string
  website: string
  /** Best guess at the vendor's name; the crawl refines it from the page. */
  name: string
  /** Which queries surfaced it. More is a stronger signal. */
  hits: number
  sampleTitle: string
  sampleUrl: string
}

/**
 * Turn search results into deduplicated vendor candidates.
 *
 * Ranked by how many distinct queries surfaced the domain: a vendor that shows
 * up under both "pricing" and "request a demo" is far more likely to be an
 * actual product than one that appeared once in a blog roundup.
 */
export function candidatesFrom(
  resultsByQuery: SerpResult[][],
): SaasCandidate[] {
  const byDomain = new Map<string, SaasCandidate & { queries: Set<number> }>()

  resultsByQuery.forEach((results, queryIndex) => {
    for (const r of results) {
      const domain = extractDomain(r.url)
      if (!isHostname(domain)) continue
      if (isExcludedHost(domain)) continue

      const existing = byDomain.get(domain)
      if (existing) {
        existing.queries.add(queryIndex)
        continue
      }
      byDomain.set(domain, {
        domain,
        website: `https://${domain}`,
        name: vendorName(r.title, domain),
        hits: 0,
        sampleTitle: r.title ?? '',
        sampleUrl: r.url,
        queries: new Set([queryIndex]),
      })
    }
  })

  return [...byDomain.values()]
    .map(c => ({
      domain: c.domain, website: c.website, name: c.name,
      hits: c.queries.size, sampleTitle: c.sampleTitle, sampleUrl: c.sampleUrl,
    }))
    .sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain))
}

/**
 * A vendor name from the result title, falling back to the domain.
 *
 * Search titles are `"SimplePractice | EHR and Practice Management Software"` —
 * the brand is the first segment before a separator. Taking the whole title
 * would put a marketing sentence into `business_name`, which `registry:match`
 * then trigram-matches against company registrations.
 */
export function vendorName(title: string, domain: string): string {
  // Separators as they actually appear: `Brand | Tagline`, `Brand – Tagline`,
  // and `Brand: Tagline` — the last with no space *before* the colon, which is
  // why this is not simply /\s+[sep]\s+/.
  const first = (title ?? '')
    .split(/\s*[|–—·]\s*|:\s+|\s+-\s+/)[0]
    .replace(/\s+/g, ' ')
    .trim()

  // A "brand" longer than this is a sentence, and a one-character one is noise.
  if (first.length >= 2 && first.length <= 40 && !/^https?:/i.test(first)) {
    return first
  }
  return domainToName(domain)
}

/** `practicepanther.com` → `Practicepanther`. Last-resort naming. */
export function domainToName(domain: string): string {
  const base = domain.replace(/^www\./, '').split('.')[0].replace(/[-_]+/g, ' ')
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export class SaasDiscovery {
  readonly name = 'saas_serp'

  constructor(
    private readonly serp: SerpSource,
    private readonly logger: Logger,
  ) {}

  /**
   * Run the query set and return ranked candidates.
   *
   * `perQuery` is capped well above what one engine returns because SearXNG
   * merges several — a single query came back with 39 results across three
   * engines once the upstreams were unblocked.
   */
  async discover(
    niche: string, location: string, perQuery = 40,
  ): Promise<{ candidates: SaasCandidate[]; queries: string[]; cachedQueries: number }> {
    const queries = saasQueries(niche, location)
    const resultsByQuery: SerpResult[][] = []
    let cachedQueries = 0

    for (const query of queries) {
      try {
        const { results, cached } = await this.serp.search(query, perQuery)
        if (cached) cachedQueries++
        resultsByQuery.push(results)
        this.logger.info('saas discovery query', {
          query, results: results.length, cached,
        })
      } catch (err) {
        // One engine outage must not lose the other four queries.
        this.logger.warn('saas discovery query failed', {
          query, err: (err as Error).message,
        })
        resultsByQuery.push([])
      }
    }

    return { candidates: candidatesFrom(resultsByQuery), queries, cachedQueries }
  }
}

/** Convenience for callers that already have a pool and logger. */
export function makeSaasDiscovery(
  provider: SerpProvider, db: Pool, logger: Logger,
): SaasDiscovery {
  return new SaasDiscovery(new SerpSource(provider, db, logger), logger)
}
