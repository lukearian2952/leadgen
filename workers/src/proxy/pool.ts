// ProxyPool — every outbound fetch declares which egress it wants.
//
// Three pools:
//   decodo_residential  rotating or sticky residential, for anything that will
//                       be blocked coming from a datacenter (Maps, LinkedIn,
//                       SERP, most site crawls)
//   datacenter          the servers' own IPs — free, fine for APIs that don't
//                       care (Socrata, Anthropic, Supabase)
//   none                direct, no agent at all
//
// Sticky sessions matter for correctness, not just politeness: a LinkedIn
// account that hops IP mid-session gets challenged, and a crawl that changes
// exit node between the homepage and /about can get two different renderings
// of the same site. Callers therefore pass a session key — the account id, or
// the domain being crawled — and get a stable exit IP for DECODO_STICKY_TTL.

import { ProxyAgent, type Dispatcher } from 'undici'
import type { Config } from '../config.js'
import { metrics } from '../metrics.js'

export type PoolName = 'decodo_residential' | 'datacenter' | 'none'

export interface FetchOptions extends RequestInit {
  /** Which egress to use. */
  pool: PoolName
  /**
   * Stable key for sticky residential sessions — a LinkedIn account id, or the
   * domain for a multi-page crawl. Omit for a fresh rotating IP per request.
   */
  session?: string
  timeoutMs?: number
  /** Attributed to this campaign in source_costs. */
  campaignId?: string
}

export interface ProxyResponse {
  response: Response
  /** Bytes read from the body, for proxy-GB accounting. */
  bytes: number
  pool: PoolName
  elapsedMs: number
}

interface StickySession {
  agent: ProxyAgent
  expiresAt: number
}

export class ProxyPool {
  private sticky = new Map<string, StickySession>()
  private rotating?: ProxyAgent
  private readonly enabled: boolean

  constructor(private readonly config: Config) {
    this.enabled = Boolean(
      config.decodo.username && config.decodo.password &&
      config.decodo.host && config.decodo.port,
    )
  }

  /** True when Decodo credentials are present; false means residential falls back. */
  get residentialAvailable(): boolean { return this.enabled }

  /**
   * Decodo encodes session stickiness in the *username*, which is the common
   * convention among residential providers: a `-session-<id>` suffix pins the
   * exit node, and `-sessionduration-<minutes>` sets how long.
   */
  private usernameFor(session?: string): string {
    const base = this.config.decodo.username
    if (!session) return base
    const id = sessionId(session)
    const minutes = Math.max(1, Math.round(this.config.decodo.stickyTtlSeconds / 60))
    return `${base}-session-${id}-sessionduration-${minutes}`
  }

  private agentFor(pool: PoolName, session?: string): Dispatcher | undefined {
    if (pool !== 'decodo_residential') return undefined
    if (!this.enabled) return undefined

    const { host, port, password } = this.config.decodo

    if (!session) {
      this.rotating ??= new ProxyAgent({
        uri: `http://${host}:${port}`,
        token: basicAuth(this.usernameFor(), password),
      })
      return this.rotating
    }

    const now = Date.now()
    const existing = this.sticky.get(session)
    if (existing && existing.expiresAt > now) return existing.agent

    // Session expired — close the old agent so its sockets are released.
    if (existing) void existing.agent.close().catch(() => {})

    const agent = new ProxyAgent({
      uri: `http://${host}:${port}`,
      token: basicAuth(this.usernameFor(session), password),
    })
    this.sticky.set(session, {
      agent,
      expiresAt: now + this.config.decodo.stickyTtlSeconds * 1000,
    })
    return agent
  }

  /**
   * Fetch through the requested pool, measuring bytes and latency.
   *
   * The body is fully buffered so the byte count is real rather than estimated
   * — proxy GB is the dominant variable cost and a guess is not good enough for
   * the ≤$0.02/business target. Callers that need streaming should not use this.
   */
  async fetch(url: string, options: FetchOptions): Promise<ProxyResponse> {
    const { pool, session, timeoutMs = 30_000, campaignId, ...init } = options

    // Asking for residential without credentials is a real degradation, not a
    // silent fallback: the caller wanted an unblockable IP and is not getting
    // one. Surfaced as a metric so it shows up in the dashboard.
    const effectivePool: PoolName =
      pool === 'decodo_residential' && !this.enabled ? 'datacenter' : pool
    if (effectivePool !== pool) {
      metrics.httpRequests.inc({ pool, outcome: 'downgraded_no_credentials' })
    }

    const dispatcher = this.agentFor(effectivePool, session)
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        // undici's dispatcher option is not in the DOM RequestInit type.
        ...(dispatcher ? { dispatcher } as Record<string, unknown> : {}),
      })

      const buffer = await response.arrayBuffer()
      const bytes = buffer.byteLength
      const elapsedMs = Date.now() - started

      metrics.httpRequests.inc({ pool: effectivePool, outcome: String(response.status) })
      metrics.proxyBytes.inc({ pool: effectivePool }, bytes)

      // Re-wrap so the caller still gets a normal Response after buffering.
      const cloned = new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })

      return { response: cloned, bytes, pool: effectivePool, elapsedMs }
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

  /** Drop a sticky session — call when an account is challenged or cooled. */
  releaseSession(session: string): void {
    const existing = this.sticky.get(session)
    if (!existing) return
    void existing.agent.close().catch(() => {})
    this.sticky.delete(session)
  }

  async close(): Promise<void> {
    const agents = [...this.sticky.values()].map(s => s.agent)
    if (this.rotating) agents.push(this.rotating)
    await Promise.allSettled(agents.map(a => a.close()))
    this.sticky.clear()
    this.rotating = undefined
  }
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** Stable, short, alphanumeric session id derived from an arbitrary key. */
export function sessionId(key: string): string {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
