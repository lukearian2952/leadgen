// Playwright config for the UI smoke tests.
//
// The tests run against the Vite dev server with **every Supabase call
// intercepted** (see `e2e/stub.ts`). Nothing reaches the real database, the
// worker fleet, or the export function.
//
// That is deliberate rather than lazy. Driving the real backend would start an
// actual campaign on each run: residential proxy bytes, Verifalia credits
// against a balance currently at 280, and rows in a production table. A smoke
// test that costs money is a smoke test nobody runs.
//
// What this therefore does *not* prove: that the pipeline works. That is what
// the worker test suite and a live campaign are for. What it does prove is that
// the UI renders, the flows connect, and the contracts it sends to Supabase are
// the ones the backend expects — which is where UI regressions actually live.

import { defineConfig, devices } from '@playwright/test'

const PORT = 5173

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Reuses a dev server if one is already up, so a watch loop and a test run do
  // not fight over the port.
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
