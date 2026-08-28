// The unverified-tier monitor.
//
// 20 of 201 Tier C rows had been given a terminal tier without any verifier
// ever running on them. `email_status` was `unknown` — the absence of a verdict,
// not a statement about a mailbox — and they were counted as unmailable in every
// yield figure the project quoted. Re-running them converted 10 of 20 to
// sendable, 8 to Tier A.
//
// Nothing was watching: the watchdog re-queues `pending_verify`, and these had
// been quietly finalised instead. This monitor exists so the next occurrence is
// an alert rather than a discovery.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ALERT_UNVERIFIED_TIERED } from '../src/verify/alerts.js'

const src = readFileSync(
  fileURLToPath(new URL('../src/jobs/reconcile.ts', import.meta.url)), 'utf8')

/** The predicate the SQL encodes, as a decision rule. */
const isSuspect = (tier: string, verifaliaChecks: number, verifySvcChecks: number) =>
  ['A', 'B', 'C'].includes(tier) && verifaliaChecks + verifySvcChecks === 0

describe('what counts as unverified', () => {
  it('flags a tiered row nothing checked', () => {
    expect(isSuspect('C', 0, 0)).toBe(true)
    expect(isSuspect('A', 0, 0)).toBe(true)
    expect(isSuspect('B', 0, 0)).toBe(true)
  })

  it('does not flag a row a verifier actually judged', () => {
    expect(isSuspect('C', 7, 0)).toBe(false)
    // hybrid topology moves the other counter.
    expect(isSuspect('C', 0, 3)).toBe(false)
  })

  it('never flags `rejected`', () => {
    // A lead with no candidate addresses is rejected *before* verification, by
    // design. Counting it would fire the alert on every campaign, and an alert
    // that always fires is not a monitor.
    expect(isSuspect('rejected', 0, 0)).toBe(false)
  })
})

describe('the check is wired into finalisation', () => {
  it('runs at the moment a tier stops being provisional', () => {
    const finalise = src.indexOf('// ── finished ──')
    const check = src.indexOf('and l.tier in (\'A\',\'B\',\'C\')')
    expect(finalise).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(finalise)
  })

  it('counts both verifier topologies, not just the paid one', () => {
    expect(src).toContain("coalesce((j.detail->>'verifalia_checks')::int, 0)")
    expect(src).toContain("coalesce((j.detail->>'verify_svc_checks')::int, 0)")
  })

  it('excludes rejected in the SQL, not only in intent', () => {
    expect(src).not.toMatch(/l\.tier in \('A','B','C','rejected'\)/)
  })

  it('raises the alert and records the count on the run', () => {
    expect(src).toContain(`kind: ALERT_UNVERIFIED_TIERED`)
    expect(src).toContain('unverified_tiered: unverifiedCount')
  })

  it('is a warning, not an error — the run worked, the number is unsafe', () => {
    const at = src.indexOf('kind: ALERT_UNVERIFIED_TIERED')
    expect(src.slice(at, at + 200)).toContain("severity: 'warning'")
  })

  it('the alert kind is the stable string the UI matches on', () => {
    expect(ALERT_UNVERIFIED_TIERED).toBe('tiered_rows_unverified')
  })
})
