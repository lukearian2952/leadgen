// Shared Socrata paging client for the NY and CO adapters.
//
// Socrata is a plain JSON API over SoQL. Two operational facts matter:
//
//   * Anonymous requests share a throttled pool. `SOCRATA_APP_TOKEN` is free
//     and moves the caller into their own bucket. It is optional here rather
//     than required, because the token is a rate-limit key and not
//     authentication — an unauthenticated request still returns the same data.
//
//   * `$limit`/`$offset` paging is stable only under an explicit `$order`.
//     Without one, Socrata does not promise a consistent row order across
//     pages, so rows can be duplicated or skipped mid-scan. Every query here
//     orders by the dataset's primary key.
//
// Goes out on the datacenter pool: Socrata does not care where the request
// comes from, and residential GB is the dominant variable cost in this fleet.

import { httpFetch } from '../../net.js'
import type { Logger } from '../../logger.js'

export interface SocrataQuery {
  select?: string
  where?: string
  order: string
  /** Rows per request. Socrata's ceiling for the JSON endpoint is 50,000. */
  pageSize?: number
  /** Hard ceiling across all pages. */
  limit?: number
}

export class SocrataClient {
  constructor(
    private readonly host: string,
    private readonly dataset: string,
    private readonly appToken: string,
    private readonly logger: Logger,
  ) {}

  get endpoint(): string {
    return `https://${this.host}/resource/${this.dataset}.json`
  }

  /** Single-value scalar query, e.g. `count(1)`. */
  async count(where?: string): Promise<number> {
    const url = new URL(this.endpoint)
    url.searchParams.set('$select', 'count(1)')
    if (where) url.searchParams.set('$where', where)
    const rows = await this.fetchPage(url)
    return Number((rows[0] as Record<string, string>)?.count_1 ?? 0)
  }

  async *pages(query: SocrataQuery): AsyncIterable<Record<string, unknown>[]> {
    const pageSize = Math.min(query.pageSize ?? 1000, 50_000)
    const ceiling = query.limit ?? Number.MAX_SAFE_INTEGER
    let offset = 0
    let yielded = 0

    while (yielded < ceiling) {
      const url = new URL(this.endpoint)
      if (query.select) url.searchParams.set('$select', query.select)
      if (query.where) url.searchParams.set('$where', query.where)
      url.searchParams.set('$order', query.order)
      url.searchParams.set('$limit', String(Math.min(pageSize, ceiling - yielded)))
      url.searchParams.set('$offset', String(offset))

      const rows = await this.fetchPage(url)
      if (!rows.length) return

      yielded += rows.length
      offset += rows.length
      yield rows

      // A short page means the result set is exhausted.
      if (rows.length < pageSize) return
    }
  }

  private async fetchPage(url: URL): Promise<Record<string, unknown>[]> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.appToken) headers['X-App-Token'] = this.appToken

    // Socrata throttles with 429 and occasionally 503s under load. Three
    // attempts with a widening gap; anything past that is a real outage and
    // should fail the job rather than silently return a partial slice — a
    // half-ingested registry looks exactly like a state with fewer officers.
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpFetch(url, {
          headers,
          signal: AbortSignal.timeout(60_000),
        })
        if (res.ok) return await res.json() as Record<string, unknown>[]

        lastError = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`
        if (res.status !== 429 && res.status < 500) break
      } catch (err) {
        lastError = (err as Error).message
      }
      const backoffMs = 1000 * attempt * attempt
      this.logger.warn('socrata retry', { attempt, backoffMs, error: lastError })
      await new Promise(r => setTimeout(r, backoffMs))
    }
    throw new Error(`socrata ${this.dataset}: ${lastError}`)
  }
}

/** `upper(col) like '%TOKEN%'` for each token, OR-ed. Tokens are escaped. */
export function likeAnyClause(column: string, tokens: string[]): string {
  const parts = tokens
    .map(t => t.toUpperCase().replace(/'/g, "''").trim())
    .filter(Boolean)
    .map(t => `upper(${column}) like '%${t}%'`)
  return parts.length ? `(${parts.join(' OR ')})` : ''
}

/** `col in ('A','B')`, or empty when the list is empty. */
export function inClause(column: string, values: string[]): string {
  const parts = values.map(v => `'${v.replace(/'/g, "''")}'`)
  return parts.length ? `${column} in (${parts.join(',')})` : ''
}

export function andClauses(...clauses: (string | undefined)[]): string {
  return clauses.filter((c): c is string => Boolean(c && c.trim())).join(' AND ')
}
