// proxy-meter — a counting, blocking HTTP/CONNECT proxy in front of Decodo.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Every other egress in this fleet goes through ProxyPool, which buffers each
// response and counts the bytes exactly. Maps discovery does not and cannot:
// gosom drives its own Chromium in a separate process and is handed a proxy
// URL. Its residential traffic has therefore been completely unmeasured — the
// one stage with a browser in it, which is the one most likely to be
// expensive. Decodo showing ~3 GB with no per-stage attribution is the direct
// consequence.
//
// So this sits between gosom and Decodo and does three jobs:
//
//   1. **Counts** bytes in both directions, per upstream host, per job.
//   2. **Blocks** hosts that serve bytes we throw away — map tiles, photos,
//      fonts, video, analytics. gosom exposes no request-interception option
//      (`-fast-mode` reduces *collection*, not transfer), so the proxy is the
//      only place this can be done without forking it.
//   3. **Enforces a budget**, refusing new connections once a job has spent
//      its allowance, so a runaway scrape cannot quietly eat a month of GB.
//
// ── Why CONNECT-level blocking is enough ─────────────────────────────────────
//
// Almost all of this traffic is HTTPS, so the proxy sees only `host:port`, not
// paths. That rules out blocking `/maps/vt?...` on a host we also need. It does
// not matter: Google serves tiles, photos and fonts from *dedicated* hosts
// (khms*.googleapis.com, *.ggpht.com, *.googleusercontent.com,
// fonts.gstatic.com), and those hosts serve nothing else we want. Blocking by
// host is coarse, sound, and reversible.

import net from 'node:net'
import http from 'node:http'
import { URL } from 'node:url'

const PORT = Number(process.env.METER_PORT ?? 8090)
const UPSTREAM_HOST = process.env.DECODO_HOST ?? ''
const UPSTREAM_PORT = Number(process.env.DECODO_PORT ?? 0)
const UPSTREAM_USER = process.env.DECODO_USERNAME ?? ''
const UPSTREAM_PASS = process.env.DECODO_PASSWORD ?? ''
const COUNTRY = (process.env.DECODO_COUNTRY ?? 'us').toLowerCase()
const BLOCKING = (process.env.METER_BLOCKING ?? 'true') !== 'false'

if (!UPSTREAM_HOST || !UPSTREAM_PORT || !UPSTREAM_USER) {
  console.error('[meter] DECODO_HOST/PORT/USERNAME are required')
  process.exit(78)
}

/**
 * Hosts whose bytes are always discarded.
 *
 * Each entry is here because it serves a *category* of asset, not because it
 * appeared once in a log. Suffix-matched, so `khms0.googleapis.com` and
 * `khms3.googleapis.com` are both covered.
 *
 * `maps.googleapis.com` is deliberately NOT blocked: it carries the API
 * responses the listing data comes from.
 */
const BLOCKED_SUFFIXES = [
  // Map tiles and satellite imagery — the single largest category.
  'khms0.googleapis.com', 'khms1.googleapis.com', 'khms2.googleapis.com',
  'khms3.googleapis.com', 'khms.googleapis.com',
  'maps.gstatic.com', 'streetviewpixels-pa.googleapis.com',
  // Business photos and user content.
  'ggpht.com', 'googleusercontent.com', 'lh3.google.com',
  // Fonts and static media.
  'fonts.gstatic.com', 'fonts.googleapis.com',
  // Analytics, ads and telemetry — pure overhead for a scraper.
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'play.google.com', 'youtube.com', 'ytimg.com', 'gstatic.com/images',
]

function isBlocked(host) {
  if (!BLOCKING) return false
  const h = host.toLowerCase()
  return BLOCKED_SUFFIXES.some(s => h === s || h.endsWith('.' + s) || h.endsWith(s))
}

// ── accounting ───────────────────────────────────────────────────────────────

const stats = {
  startedAt: new Date().toISOString(),
  bytesUp: 0,
  bytesDown: 0,
  connections: 0,
  blocked: 0,
  blockedBytesSaved: 0,   // estimated, see note in /metrics
  refusedOverBudget: 0,
  byHost: Object.create(null),
}

/** Bytes allowed before new connections are refused. 0 = unlimited. */
let budgetBytes = Number(process.env.METER_BUDGET_BYTES ?? 0)

function note(host, up, down) {
  stats.bytesUp += up
  stats.bytesDown += down
  const e = stats.byHost[host] ?? (stats.byHost[host] = { up: 0, down: 0, n: 0 })
  e.up += up; e.down += down; e.n++
}

function overBudget() {
  return budgetBytes > 0 && (stats.bytesUp + stats.bytesDown) >= budgetBytes
}

// ── upstream ─────────────────────────────────────────────────────────────────

/** Decodo wants `user-<name>-country-<cc>`; a bare username gets a random exit. */
function upstreamAuth() {
  const user = COUNTRY ? `user-${UPSTREAM_USER}-country-${COUNTRY}` : UPSTREAM_USER
  return 'Basic ' + Buffer.from(`${user}:${UPSTREAM_PASS}`).toString('base64')
}

/**
 * Open a tunnel through Decodo and splice it to the client.
 *
 * The client (gosom's Chromium) already believes it is talking to a proxy, so
 * we speak CONNECT upstream as well and forward the raw stream. Bytes are
 * counted on both pipes.
 */
function tunnel(clientSocket, head, targetHost, targetPort) {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstream.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      `Proxy-Authorization: ${upstreamAuth()}\r\n` +
      'Proxy-Connection: Keep-Alive\r\n\r\n')
  })

  let handshake = ''
  let established = false
  let up = 0, down = 0

  upstream.on('data', chunk => {
    if (established) {
      down += chunk.length
      clientSocket.write(chunk)
      return
    }
    handshake += chunk.toString('latin1')
    const end = handshake.indexOf('\r\n\r\n')
    if (end === -1) return

    const statusLine = handshake.slice(0, handshake.indexOf('\r\n'))
    const ok = / 200 /.test(statusLine)
    established = true

    if (!ok) {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`)
      upstream.destroy()
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) { up += head.length; upstream.write(head) }

    // Anything after the handshake in this same chunk is already payload.
    const rest = handshake.slice(end + 4)
    if (rest.length) { down += rest.length; clientSocket.write(Buffer.from(rest, 'latin1')) }
  })

  clientSocket.on('data', chunk => { up += chunk.length; upstream.write(chunk) })

  const done = () => {
    note(targetHost, up, down)
    upstream.destroy()
    clientSocket.destroy()
  }
  clientSocket.on('end', done); clientSocket.on('error', done)
  upstream.on('end', done);     upstream.on('error', done)
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Control plane, served on the same port so nothing else has to be exposed.
  if (req.url === '/metrics' || req.url === '/meter/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ...stats,
      totalBytes: stats.bytesUp + stats.bytesDown,
      totalMb: Number(((stats.bytesUp + stats.bytesDown) / 1e6).toFixed(3)),
      budgetBytes,
      blocking: BLOCKING,
      // Top talkers, so an unexpected host shows up rather than hiding in a total.
      topHosts: Object.entries(stats.byHost)
        .map(([host, v]) => ({ host, mb: Number(((v.up + v.down) / 1e6).toFixed(3)), n: v.n }))
        .sort((a, b) => b.mb - a.mb).slice(0, 25),
    }, null, 2))
    return
  }

  if (req.url === '/meter/reset' && req.method === 'POST') {
    stats.bytesUp = 0; stats.bytesDown = 0; stats.connections = 0
    stats.blocked = 0; stats.refusedOverBudget = 0
    stats.byHost = Object.create(null)
    stats.startedAt = new Date().toISOString()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return
  }

  if (req.url?.startsWith('/meter/budget') && req.method === 'POST') {
    const v = Number(new URL(req.url, 'http://x').searchParams.get('bytes') ?? 0)
    budgetBytes = Number.isFinite(v) && v >= 0 ? v : budgetBytes
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, budgetBytes }))
    return
  }

  // Plain HTTP through the proxy. Rare from Chromium but not impossible.
  if (!req.url?.startsWith('http')) {
    res.writeHead(400); res.end('proxy: absolute URL required'); return
  }
  let target
  try { target = new URL(req.url) } catch { res.writeHead(400); res.end('bad url'); return }

  if (isBlocked(target.hostname)) {
    stats.blocked++
    res.writeHead(403); res.end('blocked by proxy-meter'); return
  }
  if (overBudget()) {
    stats.refusedOverBudget++
    res.writeHead(509); res.end('proxy-meter budget exhausted'); return
  }

  const proxied = http.request({
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method,
    path: req.url,
    headers: { ...req.headers, 'proxy-authorization': upstreamAuth() },
  }, upRes => {
    let down = 0
    upRes.on('data', c => { down += c.length })
    upRes.on('end', () => note(target.hostname, 0, down))
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  proxied.on('error', () => { res.writeHead(502); res.end('upstream error') })
  req.pipe(proxied)
})

server.on('connect', (req, clientSocket, head) => {
  const [host, portRaw] = (req.url ?? '').split(':')
  const port = Number(portRaw || 443)
  stats.connections++

  if (!host) { clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }

  if (isBlocked(host)) {
    stats.blocked++
    // 403 rather than a black hole: Chromium retries a hung connect and would
    // spend the very bytes this is trying to save.
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }

  if (overBudget()) {
    stats.refusedOverBudget++
    clientSocket.end('HTTP/1.1 509 Bandwidth Limit Exceeded\r\n\r\n')
    return
  }

  tunnel(clientSocket, head, host, port)
})

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    msg: 'proxy-meter listening', port: PORT,
    upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, country: COUNTRY,
    blocking: BLOCKING, blockedSuffixes: BLOCKED_SUFFIXES.length,
    budgetBytes,
  }))
})
