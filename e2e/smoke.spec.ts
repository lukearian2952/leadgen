// The create → run → export smoke test.
//
// One path through the app that a person actually takes, asserted at each step
// on both what is rendered and what was sent to the backend. Backend calls are
// stubbed — see `e2e/stub.ts` for why.

import { test, expect } from '@playwright/test'
import { signInAs, stubSupabase, makeCampaign, capturePopups, openedUrls, TEST_USER } from './stub'

test.describe('create → run → export', () => {
  test('a campaign can be created, started, and exported', async ({ page }) => {
    const rec = await stubSupabase(page, { campaigns: [] })
    await signInAs(page)

    // ── the empty dashboard ────────────────────────────────────────────────
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible()

    // ── create ─────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: /new campaign/i }).click()
    await expect(page).toHaveURL(/\/new$/)

    await page.getByLabel(/niche/i).fill('med spa')
    await page.getByLabel(/^location/i).fill('Long Island NY')

    const submit = page.getByRole('button', { name: /start|create|launch/i }).last()
    await expect(submit).toBeEnabled()
    await submit.click()

    // The row is written before the run is requested — a campaign that was
    // started but never persisted would be unrecoverable.
    await expect.poll(() => rec.inserts.filter(i => i.table === 'campaigns').length)
      .toBeGreaterThan(0)

    const insert = rec.inserts.find(i => i.table === 'campaigns')!
    const row = (Array.isArray(insert.body) ? insert.body[0] : insert.body) as Record<string, unknown>
    expect(row.niche).toBe('med spa')
    expect(row.location).toBe('Long Island NY')

    // ── run ────────────────────────────────────────────────────────────────
    //
    // The v2 RPC, not the v1 orchestrator Edge Function. This assertion is the
    // point of the test: the only button a user could press used to run the
    // pipeline this rebuild replaced, at Places API prices.
    await expect.poll(() => rec.rpcCalls.map(c => c.name)).toContain('start_campaign_v2')

    const start = rec.rpcCalls.find(c => c.name === 'start_campaign_v2')!
    const args = start.body as Record<string, unknown>
    expect(args.p_campaign_id).toBeTruthy()
    expect(Number(args.p_residential_budget_bytes)).toBeGreaterThan(0)

    // The frontend must not write `status` itself — doing so raced the claim
    // guards and made Resume a silent no-op.
    expect(rec.inserts.some(i =>
      i.table === 'campaigns' &&
      typeof (i.body as Record<string, unknown>)?.status === 'string' &&
      (i.body as Record<string, unknown>).status === 'running')).toBe(false)

    await expect(page).toHaveURL(/\/campaign\//)
  })

  test('export requests both CSVs and surfaces the links', async ({ page }) => {
    const campaign = makeCampaign({ status: 'completed', current_step: 6, stat_owner_ready: 42 })
    const rec = await stubSupabase(page, { campaigns: [campaign] })
    await signInAs(page)

    await capturePopups(page)
    await page.goto(`/campaign/${campaign.id}`)
    await page.getByRole('button', { name: /export/i }).click()

    await expect.poll(() => rec.exports).toContain(campaign.id)

    // The sendable CSV is opened in a new tab rather than linked, so the
    // assertion is on the open() call — not on a link that does not exist.
    await expect.poll(() => openedUrls(page)).toContain('https://example.invalid/leads.csv')

    // The rejected list is offered as a link rather than auto-opened. It is how
    // a thin run is diagnosed instead of guessed at, so its absence is a real
    // regression.
    const rejected = page.getByRole('link', { name: /rejected/i })
    await expect(rejected).toBeVisible()
    await expect(rejected).toHaveAttribute('href', /leads-rejected\.csv/)

    // The counts come from the response, so a shape change shows up here.
    await expect(page.getByText(/42 owner-ready/)).toBeVisible()
    await expect(page.getByText(/58 rejected/)).toBeVisible()
  })

  test('an export failure is shown, not swallowed', async ({ page }) => {
    const campaign = makeCampaign({ status: 'completed', current_step: 6 })
    await stubSupabase(page, { campaigns: [campaign], exportError: 'no leads passed the gate' })
    await signInAs(page)

    await page.goto(`/campaign/${campaign.id}`)
    await page.getByRole('button', { name: /export/i }).click()

    await expect(page.getByText(/no leads passed the gate/i)).toBeVisible()
  })
})

test.describe('auth', () => {
  test('an unauthenticated visitor is sent to login', async ({ page }) => {
    await stubSupabase(page)
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('a signed-in operator reaches the dashboard', async ({ page }) => {
    await stubSupabase(page, { campaigns: [makeCampaign()] })
    await signInAs(page, TEST_USER)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible()
  })
})
