# DEPRECATED — this frontend has moved into MailForge

**Nothing here is deployed any more.** The Lead Gen UI now lives in MailForge as
a first-class tab:

    /Users/mac/Desktop/Dev/Cold Emailing SaaS
      src/pages/leadgen/          Campaigns, builder, detail, ops, exports
      src/components/leadgen/     Funnel, tiers, evidence drawer, alerts, bridge
      src/hooks/useLeadgen*.ts    All Lead Gen data access
      src/lib/leadgenSupabase.ts  The second Supabase client
      src/lib/leadgenBridge.ts    Lead Gen rows → MailForge lead lists

Merged 2026-08-29. **Do not add features here.** Anything built in this
directory will not reach a browser.

## What did and did not move

| this directory | in MailForge |
|---|---|
| `pages/DashboardPage` | `pages/leadgen/LeadgenCampaigns` |
| `pages/NewCampaignPage` | `pages/leadgen/LeadgenNew` |
| `pages/CampaignDetailPage` | `pages/leadgen/LeadgenCampaignDetail` |
| `pages/LoginPage` | `components/leadgen/LeadgenSignIn` — a gate on the tab, not a route |
| `components/campaign/*` | `components/leadgen/*`, rebuilt in MailForge's design system |
| `lib/tiers.ts` | `lib/leadgenTiers.ts`, behaviour unchanged |
| `lib/types.ts` | `types/leadgen.ts`, extended |

MailForge additionally has a **Jobs & Ops** page and an **Exports** page that
never existed here, and **Send to MailForge**, which turns a finished campaign
into MailForge lead lists directly.

## The backend did not move

The worker fleet, this Supabase project, registry-db and the crons are
untouched and are still the system of record. `docs/OPERATIONS.md`,
`docs/RUNBOOK.md` and `docs/HANDOFF.md` remain correct and remain the place to
look; only §2, "The dashboards", changed.

MailForge reaches this project through a **second Supabase client** with its own
anon key and its own auth session — two projects, two auth realms. The Lead Gen
tab asks for a Lead Gen sign-in the first time it is opened.

## Why this is kept rather than deleted

`lib/tiers.ts` here is exercised by the workers' vitest suite
(`workers/test/frontend-tiers.test.ts`), which is the only test coverage the
tier logic has. Deleting this directory would delete that coverage. The port in
MailForge is a copy, not a move, for that reason.
