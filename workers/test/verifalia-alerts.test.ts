// Verifalia must never fail silently.
//
// A 402 removed the entire safety net for a Phase 2 run. Every layer behaved
// correctly — logged, returned unknown, spent nothing — and the run still
// produced zero Tier A rows with no visible reason. These assert that the two
// conditions which invalidate a whole run raise an alert and mark their results
// `unavailable`, so the batch reroutes instead of being mistaken for verdicts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The provider calls `httpFetch`, which is undici with a pinned dispatcher, not
// global fetch. Mocking globalThis.fetch leaves it untouched and the test
// silently makes a real request to api.verifalia.com — so mock the module.
vi.mock('../src/net.js', () => ({
  httpFetch: vi.fn(),
  networkMode: () => 'test',
}))

import { httpFetch } from '../src/net.js'
import { VerifaliaProvider } from '../src/verify/verifalia.js'
import {
  MemoryAlertSink, ALERT_VERIFALIA_PAYMENT, ALERT_VERIFALIA_AUTH,
} from '../src/verify/alerts.js'
import { Logger } from '../src/logger.js'

const silent = new Logger('error')
const fetchMock = vi.mocked(httpFetch)

function respondWith(status: number, body: unknown = {}) {
  // httpFetch is typed with undici's Response, which is structurally a superset
  // of the global one. The cast is the seam between the two type packages, not
  // a claim that the shapes are unrelated.
  const res = new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }) as unknown as Awaited<ReturnType<typeof httpFetch>>
  fetchMock.mockResolvedValue(res)
}

beforeEach(() => { fetchMock.mockReset() })

describe('Verifalia credential and credit failures', () => {
  it('raises a payment alert on HTTP 402 and marks results unavailable', async () => {
    respondWith(402, { error: 'payment required' })

    const alerts = new MemoryAlertSink()
    const provider = new VerifaliaProvider('user', 'pass', silent, 5_000, alerts, 'campaign-1')

    const results = await provider.verify(['a@x.com', 'b@x.com'])

    expect(alerts.kinds()).toContain(ALERT_VERIFALIA_PAYMENT)

    const alert = alerts.raised.find(a => a.kind === ALERT_VERIFALIA_PAYMENT)!
    expect(alert.severity).toBe('error')
    expect(alert.campaignId).toBe('campaign-1')
    expect(alert.detail?.http_status).toBe(402)
    // The message has to say what it means for the run, not just echo the code.
    expect(alert.message).toMatch(/out of credits/i)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.status === 'unknown')).toBe(true)
    expect(results.every(r => r.unavailable === true)).toBe(true)
    // A failed call must never be billed.
    expect(results.every(r => r.cost_cents === 0)).toBe(true)
  })

  it('raises an auth alert on HTTP 401', async () => {
    respondWith(401, { error: 'unauthorized' })

    const alerts = new MemoryAlertSink()
    const provider = new VerifaliaProvider('user', 'bad', silent, 5_000, alerts, 'campaign-2')

    const results = await provider.verify(['a@x.com'])

    expect(alerts.kinds()).toContain(ALERT_VERIFALIA_AUTH)
    expect(alerts.raised[0].message).toMatch(/credentials/i)
    expect(results[0].unavailable).toBe(true)
    expect(results[0].status).toBe('unknown')
  })

  it('does not alert on an ordinary transient failure', async () => {
    // A 500 is worth retrying and does not mean the account is unusable, so it
    // must not raise the "no safety net" alarm.
    respondWith(500, { error: 'server error' })

    const alerts = new MemoryAlertSink()
    const provider = new VerifaliaProvider('user', 'pass', silent, 200, alerts, 'campaign-3')

    const results = await provider.verify(['a@x.com'])

    expect(alerts.raised).toHaveLength(0)
    expect(results[0].status).toBe('unknown')
    // Not flagged unavailable: one bad response is not a fleet condition.
    expect(results[0].unavailable).toBeUndefined()
  })

  it('reports unknown without alerting when no credentials are configured', async () => {
    const alerts = new MemoryAlertSink()
    const provider = new VerifaliaProvider('', '', silent, 5_000, alerts, 'campaign-4')

    const results = await provider.verify(['a@x.com'])

    expect(alerts.raised).toHaveLength(0)
    expect(results[0].status).toBe('unknown')
    expect(results[0].cost_cents).toBe(0)
  })
})
