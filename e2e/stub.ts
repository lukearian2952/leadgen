// A stubbed Supabase, so the UI can be driven without a backend.
//
// ── Why intercept rather than point at a test project ───────────────────────
//
// The app talks to Supabase for everything: auth, campaign rows, leads, logs,
// alerts, the `start_campaign_v2` RPC and the export function. Running the
// tests against the real project would enqueue real work — residential bytes
// and Verifalia credits — and would make assertions depend on whatever rows
// happen to exist. Both make a smoke test unreliable and expensive.
//
// So every call is intercepted. The stub answers with the *shapes* the app
// expects, and records what was sent, which is what lets a test assert that the
// UI asked the backend for the right thing.
//
// ── Auth ────────────────────────────────────────────────────────────────────
//
// Seeded through localStorage rather than by faking the sign-in network call.
// supabase-js reads `sb-<ref>-auth-token` on boot; writing it before the first
// navigation means `AuthGuard` passes without the test having to log in on
// every spec. `signIn()` is still exercised directly by the login spec.

import type { Page, Route } from '@playwright/test'

/** Matches the project ref in VITE_SUPABASE_URL. */
export const PROJECT_REF = 'paasggeawsoctfgqbqrd'

export const TEST_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'operator@example.com',
}

export interface Campaign {
  id: string
  user_id: string
  niche: string
  location: string
  target_count: number
  status: string
  current_step: number
  created_at: string
  completed_at: string | null
  step1_done: number
  stat_owner_ready: number
  stat_rejected: number
  stat_owners: number
  stat_emails: number
  stat_dropped_step1: number
  spend_estimate_usd: number
  spend_detail: Record<string, unknown>
}

export function makeCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: TEST_USER.id,
    niche: 'med spa',
    location: 'Long Island NY',
    target_count: 100,
    status: 'pending',
    current_step: 0,
    created_at: new Date().toISOString(),
    completed_at: null,
    step1_done: 0,
    stat_owner_ready: 0,
    stat_rejected: 0,
    stat_owners: 0,
    stat_emails: 0,
    stat_dropped_step1: 0,
    spend_estimate_usd: 0,
    spend_detail: {},
    ...over,
  }
}

/** What the UI asked the backend to do, for assertions. */
export interface Recorder {
  rpcCalls: Array<{ name: string; body: unknown }>
  inserts: Array<{ table: string; body: unknown }>
  exports: string[]
  requests: string[]
}

export interface StubOptions {
  campaigns?: Campaign[]
  leads?: Array<Record<string, unknown>>
  alerts?: Array<Record<string, unknown>>
  preflight?: Array<Record<string, unknown>>
  logs?: Array<Record<string, unknown>>
  /** Make the export fail, to exercise the error path. */
  exportError?: string
  /** Make start_campaign_v2 fail. */
  startError?: string
}

/**
 * PostgREST filter subset: `col=eq.value`.
 *
 * Enough for what the app sends (`.eq('id', …)`, `.eq('campaign_id', …)`), and
 * a stub that ignored filters would hand a campaign detail page every campaign
 * in the fixture and pass tests that should fail.
 */
function applyFilters(
  rows: Array<Record<string, unknown>>, params: URLSearchParams,
): Array<Record<string, unknown>> {
  let out = rows
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue
    if (!raw.startsWith('eq.')) continue
    const want = raw.slice(3)
    out = out.filter(r => String(r[key] ?? '') === want)
  }
  return out
}

/**
 * Answer in the shape the caller asked for.
 *
 * `.single()` sets `Accept: application/vnd.pgrst.object+json` and supabase-js
 * expects a bare object; handed an array it errors and the page renders its
 * loading state forever. That is exactly how the first run of this suite
 * failed — the campaign detail page never resolved and no Export button ever
 * appeared.
 */
function respond(
  route: Route, req: { headers(): Record<string, string> },
  rows: Array<Record<string, unknown>>, status = 200,
) {
  const accept = req.headers()['accept'] ?? ''
  if (accept.includes('vnd.pgrst.object')) {
    if (!rows.length) {
      return json(route, {
        code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned',
      }, 406)
    }
    return json(route, rows[0], status)
  }
  return json(route, rows, status)
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  })

/**
 * Record `window.open` calls.
 *
 * The sendable CSV is opened in a new tab rather than linked, and the stub's
 * URLs point at a host that does not resolve — so a real popup never finishes
 * navigating and `popup.url()` is unreliable. Capturing the call is both
 * deterministic and a more direct assertion: the question is whether the app
 * tried to open the right file.
 */
export async function capturePopups(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] }
    w.__opened = []
    window.open = ((url?: string | URL) => {
      w.__opened.push(String(url ?? ''))
      return null
    }) as typeof window.open
  })
}

export async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __opened: string[] }).__opened ?? [])
}

/** Seed a session so AuthGuard lets the app render. */
export async function signInAs(page: Page, user = TEST_USER): Promise<void> {
  const session = {
    access_token: 'stub-access-token',
    refresh_token: 'stub-refresh-token',
    token_type: 'bearer',
    // Comfortably future-dated: an expired token sends supabase-js into a
    // refresh loop against a URL the stub does not model.
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    expires_in: 60 * 60 * 24,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  }

  await page.addInitScript(
    ([ref, s]) => {
      window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s))
    },
    [PROJECT_REF, session] as const,
  )
}

/**
 * Intercept everything the app sends to Supabase.
 *
 * Returns the recorder so a test can assert on what was sent, not only on what
 * was rendered — "the Start button called start_campaign_v2 with this campaign
 * id" is the contract that actually matters.
 */
export async function stubSupabase(page: Page, opts: StubOptions = {}): Promise<Recorder> {
  const rec: Recorder = { rpcCalls: [], inserts: [], exports: [], requests: [] }
  const campaigns = [...(opts.campaigns ?? [])]

  // Realtime. The app opens a websocket per subscription; without this the
  // console fills with connection errors that make real failures hard to see.
  await page.routeWebSocket(/realtime/, ws => ws.onMessage(() => {}))

  await page.route('**/auth/v1/**', async route => {
    const url = route.request().url()
    rec.requests.push(url)
    if (url.includes('/logout')) return json(route, {})
    return json(route, { data: null, error: null })
  })

  await page.route('**/rest/v1/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    const table = url.pathname.replace('/rest/v1/', '').split('?')[0]
    rec.requests.push(url.toString())

    if (req.method() === 'POST') {
      const body = req.postDataJSON?.() ?? null
      rec.inserts.push({ table, body })
      if (table === 'campaigns') {
        const row = makeCampaign({
          ...(Array.isArray(body) ? body[0] : body),
          id: `c-${campaigns.length + 1}-0000-4000-8000-000000000000`,
        })
        campaigns.push(row)
        return respond(route, req, [row], 201)
      }
      return respond(route, req, [], 201)
    }

    if (req.method() === 'PATCH' || req.method() === 'DELETE') {
      return respond(route, req, [])
    }

    const source: Array<Record<string, unknown>> =
      table === 'campaigns'      ? campaigns as unknown as Array<Record<string, unknown>>
      : table === 'leads'        ? (opts.leads ?? [])
      : table === 'campaign_logs'? (opts.logs ?? [])
      : table === 'alerts'       ? (opts.alerts ?? [])
      : table === 'preflight_runs' ? (opts.preflight ?? [])
      : []

    return respond(route, req, applyFilters(source, url.searchParams))
  })

  // Registered *after* the generic table route on purpose: Playwright matches
  // routes in reverse registration order, so the last one registered wins. With
  // these the other way round the generic handler swallowed every RPC — the
  // recorder stayed empty and `start_campaign_v2` returned `[]`, which
  // `useCampaignRunner` read as a successful start. The flow appeared to work
  // and the assertion that it had actually been called was the only thing that
  // noticed.
  await page.route('**/rest/v1/rpc/**', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.split('/').pop() ?? ''
    const body = route.request().postDataJSON?.() ?? null
    rec.rpcCalls.push({ name, body })
    rec.requests.push(url.toString())

    if (name === 'start_campaign_v2') {
      if (opts.startError) {
        return json(route, { message: opts.startError }, 400)
      }
      return json(route, { started: true, stage: 'maps:discover' })
    }
    return json(route, null)
  })

  await page.route('**/functions/v1/campaign-export**', async route => {
    const url = new URL(route.request().url())
    rec.exports.push(url.searchParams.get('campaign_id') ?? '')
    rec.requests.push(url.toString())
    if (opts.exportError) {
      return json(route, { error: opts.exportError }, 500)
    }
    // Field names copied from `ExportResult` in ExportButton.tsx. A stub that
    // invents its own shape tests nothing: the component would render undefined
    // counts and the assertions would still pass.
    return json(route, {
      url: 'https://example.invalid/leads.csv',
      rejected_url: 'https://example.invalid/leads-rejected.csv',
      owner_ready: 42,
      rejected: 58,
      total: 100,
    })
  })

  return rec
}
