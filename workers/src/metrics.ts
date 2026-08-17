// Prometheus-style metrics and a health endpoint, served on METRICS_PORT.
//
// Deliberately hand-rolled rather than pulling in prom-client: we export four
// metric shapes, the text format is trivial, and the brief asks for a small
// self-contained fleet. If this grows past counters/gauges/histograms, swap it.

import { createServer, type Server } from 'node:http'

type Labels = Record<string, string>

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ''
  return keys.map(k => `${k}="${escapeLabel(labels[k])}"`).join(',')
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

class Counter {
  private values = new Map<string, number>()
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, by = 1) {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + by)
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    if (!this.values.size) lines.push(`${this.name} 0`)
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`)
    }
    return lines.join('\n')
  }
}

class Gauge {
  private values = new Map<string, number>()
  constructor(readonly name: string, readonly help: string) {}

  set(labels: Labels, value: number) { this.values.set(labelKey(labels), value) }

  /**
   * Relative adjustment. In-flight counts must use this rather than set():
   * with concurrency > 1 two jobs of the same stage overlap, and a set(1) /
   * set(0) pair would report zero in flight while one is still running.
   */
  add(labels: Labels, delta: number) {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + delta)
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`)
    }
    return lines.join('\n')
  }
}

/**
 * Fixed-bucket histogram. Buckets are in seconds and chosen for the work these
 * workers actually do — a SERP query is sub-second, an SMTP probe with our
 * mandated 3–5 s inter-RCPT gap is not.
 */
class Histogram {
  private buckets = new Map<string, number[]>()
  private sums = new Map<string, number>()
  private counts = new Map<string, number>()
  static readonly BOUNDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

  constructor(readonly name: string, readonly help: string) {}

  observe(labels: Labels, seconds: number) {
    const key = labelKey(labels)
    if (!this.buckets.has(key)) {
      this.buckets.set(key, new Array(Histogram.BOUNDS.length).fill(0))
    }
    const counts = this.buckets.get(key)!
    Histogram.BOUNDS.forEach((bound, i) => { if (seconds <= bound) counts[i]++ })
    this.sums.set(key, (this.sums.get(key) ?? 0) + seconds)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const [key, counts] of this.buckets) {
      const sep = key ? ',' : ''
      Histogram.BOUNDS.forEach((bound, i) => {
        lines.push(`${this.name}_bucket{${key}${sep}le="${bound}"} ${counts[i]}`)
      })
      lines.push(`${this.name}_bucket{${key}${sep}le="+Inf"} ${this.counts.get(key) ?? 0}`)
      lines.push(key ? `${this.name}_sum{${key}} ${this.sums.get(key) ?? 0}`
                     : `${this.name}_sum ${this.sums.get(key) ?? 0}`)
      lines.push(key ? `${this.name}_count{${key}} ${this.counts.get(key) ?? 0}`
                     : `${this.name}_count ${this.counts.get(key) ?? 0}`)
    }
    return lines.join('\n')
  }
}

export const metrics = {
  jobsTotal:      new Counter('leadgen_jobs_total', 'Jobs finished, by stage and status.'),
  jobDuration:    new Histogram('leadgen_job_duration_seconds', 'Job wall-clock duration by stage.'),
  jobsInFlight:   new Gauge('leadgen_jobs_in_flight', 'Jobs currently executing, by stage.'),
  queueDepth:     new Gauge('leadgen_queue_depth', 'Runnable jobs waiting in the queue.'),
  deadLetterTotal: new Counter('leadgen_dead_letter_total', 'Jobs written to dead_letter, by stage.'),
  httpRequests:   new Counter('leadgen_outbound_requests_total', 'Outbound HTTP requests by pool and outcome.'),
  proxyBytes:     new Counter('leadgen_proxy_bytes_total', 'Bytes received through each proxy pool.'),
  verifyChecks:   new Counter('leadgen_verify_checks_total', 'Verification checks by provider and status.'),
  verifyBlocks:   new Counter('leadgen_verify_blocks_total', 'Verifier IP blocks observed, by ip.'),
  llmTokens:      new Counter('leadgen_llm_tokens_total', 'Anthropic tokens by direction.'),
}

const REGISTRY = [
  metrics.jobsTotal, metrics.jobDuration, metrics.jobsInFlight, metrics.queueDepth,
  metrics.deadLetterTotal, metrics.httpRequests, metrics.proxyBytes,
  metrics.verifyChecks, metrics.verifyBlocks, metrics.llmTokens,
]

export function renderMetrics(): string {
  return REGISTRY.map(m => m.render()).join('\n\n') + '\n'
}

export interface HealthState {
  /** False once the queue runner has stopped or the DB is unreachable. */
  healthy: boolean
  detail: Record<string, unknown>
}

/**
 * One tiny HTTP server per worker exposing /healthz and /metrics. Docker's
 * healthcheck and Prometheus both hit this; nothing else is served.
 */
/**
 * Optional POST route, registered only by the worker role that owns it.
 *
 * The feedback endpoint lives here rather than in its own service because this
 * server already exists on every worker, is already bound to 127.0.0.1 by
 * docker-compose, and is therefore already covered by the security posture in
 * HANDOFF §2 — every LeadGen port is loopback-only except the firewalled
 * verify-svc. A new public listener would need its own iptables rule and would
 * be one more thing to get wrong.
 */
export interface PostRoute {
  path: string
  handle: (body: unknown) => Promise<{ status: number; body: unknown }>
}

export function startMetricsServer(
  port: number, getHealth: () => HealthState, postRoutes: PostRoute[] = [],
): Server {
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      const route = postRoutes.find(r => r.path === req.url)
      if (route) { handlePost(req, res, route); return }
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
      res.end(renderMetrics())
      return
    }
    if (req.url === '/healthz' || req.url === '/health') {
      const health = getHealth()
      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  server.listen(port)
  return server
}

/** 64 KB is far more than any webhook needs and stops a bad caller eating RAM. */
const MAX_BODY_BYTES = 64 * 1024

function handlePost(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  route: PostRoute,
): void {
  const chunks: Buffer[] = []
  let size = 0
  let aborted = false

  const fail = (status: number, error: string) => {
    aborted = true
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error }))
  }

  req.on('data', chunk => {
    if (aborted) return
    size += chunk.length
    if (size > MAX_BODY_BYTES) { req.destroy(); return fail(413, 'body too large') }
    chunks.push(chunk as Buffer)
  })

  req.on('end', () => {
    if (aborted) return
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return fail(400, 'body is not valid JSON')
    }
    route.handle(parsed)
      .then(result => {
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
      })
      .catch((err: Error) => {
        // 500, not 400: the caller's retry is the right response to our fault.
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      })
  })
}
