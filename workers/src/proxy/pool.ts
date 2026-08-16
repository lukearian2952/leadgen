// ProxyPool — every outbound fetch declares which egress it wants.
//
//   decodo_residential  rotating or sticky residential, for anything that will
//                       be blocked or geo-skewed from a datacenter (Maps,
//                       LinkedIn, SERP, most site crawls)
//   datacenter          the server's own IP — free, fine for APIs that do not
//                       care (Socrata, Anthropic, Supabase)
//   none                direct, no agent
//
// ── Decodo's actual conventions, measured 2026-08-16 ─────────────────────────
//
// The first version of this file assumed a `-session-<id>` username suffix.
// That is wrong for this account and fails authentication outright ("Access
// denied. We couldn't log you in with the details provided"). What Decodo
// really does:
//
//   * Rotating  : port 7000. Every request exits from a different IP.
//   * Sticky    : ports 10001+. The *port* is the session — one port holds one
//                 exit IP for the session lifetime. Different port, different
//                 IP; same port, same IP.
//   * Targeting : the username must be prefixed, `user-<name>-country-us`.
//                 Bare `<name>-country-us` fails auth.
//
// The targeting default is not cosmetic. Without `-country-us` the pool hands
// out global exits — a sticky session came back as VTR Banda Ancha in Santiago,
// Chile. Scraping Long Island med spas through a Chilean residential IP would
// have Google serving a different, localised result set, and the funnel numbers
// would have been quietly wrong rather than obviously broken.
//
// One caveat worth knowing: a sticky port that already has a live session keeps
// that session's exit until it expires, so changing the country filter does not
// take effect on a port mid-session. Ports are therefore never shared between
// different country targets.

import { ProxyAgent, type Dispatcher } from 'undici'
import type { Config } from '../config.js'
import { metrics } from '../metrics.js'

export type PoolName = 'decodo_residential' | 'datacenter' | 'none'

export interface FetchOptions extends RequestInit {
  pool: PoolName
  /**
   * Stable key for a sticky session — the domain being crawled, or a LinkedIn
   * account id. Omit for a fresh rotating IP per request.
   */
  session?: string
  timeoutMs?: number
  campaignId?: string
}

export interface ProxyResponse {
  response: Response
  bytes: number
  pool: PoolName
  /** Which egress port was used, for debugging a blocked exit. */
  port?: number
  elapsedMs: number
}

export class ProxyPool {
  private agents = new Map<number, ProxyAgent>()
  private readonly enabled: boolean

  constructor(private readonly config: Config) {
    this.enabled = Boolean(
      config.decodo.username && config.decodo.password && config.decodo.host,
    )
  }

  get residentialAvailable(): boolean { return this.enabled }

  /** `user-<name>-country-<cc>`; the `user-` prefix is required for targeting. */
  private username(): string {
    const { username, country } = this.config.decodo
    return country ? `user-${username}-country-${country}` : username
  }

  /**
   * Sticky sessions map a key onto a port in the configured range. Hashing
   * rather than round-robin means the same domain returns to the same exit
   * across separate jobs, which is what keeps a multi-page crawl coherent.
   */
  private portFor(session?: string): number {
    if (!session) return this.config.decodo.rotatingPort
    const { stickyPortMin, stickyPortMax } = this.config.decodo
    const span = Math.max(1, stickyPortMax - stickyPortMin + 1)
    return stickyPortMin + (hash(session) % span)
  }

  private agentFor(port: number): ProxyAgent {
    let agent = this.agents.get(port)
    if (!agent) {
      agent = new ProxyAgent({
        uri: `http://${this.config.decodo.host}:${port}`,
        token: basicAuth(this.username(), this.config.decodo.password),
      })
      this.agents.set(port, agent)
    }
    return agent
  }

  async fetch(url: string, options: FetchOptions): Promise<ProxyResponse> {
    const { pool, session, timeoutMs = 30_000, campaignId, ...init } = options

    // Asking for residential without credentials is a real degradation, not a
    // silent fallback: the caller wanted an unblockable, geo-correct IP and is
    // not getting one.
    const effectivePool: PoolName =
      pool === 'decodo_residential' && !this.enabled ? 'datacenter' : pool
    if (effectivePool !== pool) {
      metrics.httpRequests.inc({ pool, outcome: 'downgraded_no_credentials' })
    }

    let dispatcher: Dispatcher | undefined
    let port: number | undefined
    if (effectivePool === 'decodo_residential') {
      port = this.portFor(session)
      dispatcher = this.agentFor(port)
    }

    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } as Record<string, unknown> : {}),
      })

      // Buffered so the byte count is real: residential egress is the dominant
      // variable cost and an estimate will not hold up against $0.02/business.
      const buffer = await response.arrayBuffer()
      const bytes = buffer.byteLength
      const elapsedMs = Date.now() - started

      metrics.httpRequests.inc({ pool: effectivePool, outcome: String(response.status) })
      metrics.proxyBytes.inc({ pool: effectivePool }, bytes)

      return {
        response: new Response(buffer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        bytes, pool: effectivePool, port, elapsedMs,
      }
    } catch (err) {
      metrics.httpRequests.inc({
        pool: effectivePool,
        outcome: (err as Error).name === 'AbortError' ? 'timeout' : 'error',
      })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Abandon a sticky session. Closing the agent drops our connections; the
   * exit itself is released by Decodo when the session times out, so the next
   * caller on that port may briefly still get the old IP.
   */
  releaseSession(session: string): void {
    const port = this.portFor(session)
    const agent = this.agents.get(port)
    if (!agent) return
    void agent.close().catch(() => {})
    this.agents.delete(port)
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map(a => a.close()))
    this.agents.clear()
  }
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** FNV-1a. Stable across processes, which round-robin would not be. */
export function hash(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Exposed for tests: which port a session key maps to. */
export function stickyPortFor(session: string, min: number, max: number): number {
  const span = Math.max(1, max - min + 1)
  return min + (hash(session) % span)
}
