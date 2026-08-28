// The alert kinds are a contract between two codebases that never import each
// other.
//
// `alerts.ts` says "Stable strings — the UI matches on them", and the UI does:
// AlertBanner keeps a TITLES map keyed on exactly those strings and falls back
// to printing the raw kind. So a worker raising a kind the banner has never
// heard of does not fail — it renders `verifalia_payment_required` at the user
// in place of a sentence, which is the kind of thing nobody notices until the
// one time the alert fires for real.
//
// There is no DOM runner here (vitest environment is 'node' and the React app
// has no test setup of its own — see frontend-tiers.test.ts), so this asserts
// the contract against the component source rather than a render. That is a
// weaker check than mounting it, and it is the check that catches the failure
// that actually happens: the two sides drifting apart.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ALERT_VERIFALIA_PAYMENT, ALERT_VERIFALIA_AUTH,
  ALERT_VERIFIER_COOLING, ALERT_NO_VERIFIER, ALERT_UNVERIFIED_TIERED,
} from '../src/verify/alerts.js'

// Read, not imported: an import would cross this package's rootDir the way
// frontend-tiers.test.ts does and would need the same tsconfig exclusion.
//
// The worker image copies only `workers/`, so the React app is absent there.
// This describes a repo-level contract, not worker behaviour, so it skips
// rather than fails when the other half of the contract is not on disk.
const BANNER = fileURLToPath(
  new URL('../../src/components/campaign/AlertBanner.tsx', import.meta.url))
const banner = existsSync(BANNER) ? readFileSync(BANNER, 'utf8') : null
const withBanner = banner ? describe : describe.skip

const KINDS = {
  ALERT_VERIFALIA_PAYMENT, ALERT_VERIFALIA_AUTH,
  ALERT_VERIFIER_COOLING, ALERT_NO_VERIFIER, ALERT_UNVERIFIED_TIERED,
}

withBanner('every alert kind the workers raise has a human title', () => {
  it.each(Object.entries(KINDS))('%s', (_name, kind) => {
    expect(banner!).toContain(`${kind}:`)
  })
})

withBanner('every severity the workers send has a style', () => {
  // AlertBanner does `STYLES[alert.severity] ?? STYLES.error`, so an unknown
  // severity is survivable — but it silently paints a warning red.
  it.each(['error', 'warning', 'info'])('%s is styled', severity => {
    expect(banner!).toMatch(new RegExp(`\\b${severity}:\\s*\\{`))
  })
})

withBanner('the drilled 402 row', () => {
  // Exactly what scripts/alert-402-drill.ts produced against a stubbed 402,
  // through the real provider and the real PgAlertSink.
  const row = {
    kind: ALERT_VERIFALIA_PAYMENT,
    severity: 'error' as const,
    occurrences: 2,
    detail: { http_status: 402, addresses_pending: 2 },
  }

  it('is a kind the banner titles', () => {
    expect(banner!).toContain(`${row.kind}: 'Verifalia is out of credits'`)
  })

  it('is a severity the banner styles, and the loudest one', () => {
    expect(row.severity).toBe('error')
    expect(banner!).toMatch(/error:\s*\{[^}]*red/s)
  })

  it('repeats are counted rather than duplicated', () => {
    // raise_alert bumps an open alert; the banner shows the count above 1.
    expect(row.occurrences).toBeGreaterThan(1)
    expect(banner!).toContain('occurrences > 1')
  })
})
