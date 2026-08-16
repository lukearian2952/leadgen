# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server (localhost:5173)
npm run build      # TypeScript compile + Vite production build
npm run preview    # Preview production build locally
```

There are no test or lint scripts configured. TypeScript strictness is enforced at build time via `tsc -b`.

Edge Functions (Deno) are deployed separately via Supabase CLI:
```bash
supabase functions deploy <function-name>
```

## Architecture

**LeadGen** is a lead generation SaaS that scrapes and exports business leads from Google Maps. It has two distinct runtime environments:

### Frontend — React + Vite (src/)

- **Entry:** `src/main.tsx` → `src/App.tsx` (React Router)
- **Auth:** Supabase Auth via `src/hooks/useAuth.ts`; protected routes use `src/components/auth/AuthGuard.tsx`
- **State:** Custom hooks only — no global state library. Key hooks:
  - `useCampaigns.ts` — fetches campaign list with Supabase Realtime subscriptions
  - `useCampaignDetail.ts` — campaign + leads + logs with live updates
  - `useCampaignRunner.ts` — triggers the pipeline via the orchestrator Edge Function
- **Data types:** All shared TypeScript interfaces live in `src/lib/types.ts`
- **Supabase client:** Initialized once in `src/lib/supabase.ts` using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`

### Backend — Deno Edge Functions (supabase/functions/)

Edge Functions use the **service role key** (not the anon key) to bypass Row Level Security for bulk writes.

Shared utilities live in `supabase/functions/_shared/`:
- `db.ts` — `serviceClient()` factory and the `Db` type alias. **Type helpers that take a client as `Db`, never `ReturnType<typeof createClient>`** — the latter is a different instantiation and fails `deno check` at every call site.
- `edge.ts` — `waitUntil()` wrapper around the runtime-injected `EdgeRuntime`
- `cors.ts` — CORS response helpers
- `owner-patterns.ts` — Metro area expansion map (`expandLocation`)
- `geo.ts` / `niche-types.ts` — location scope and niche→Place-type rules (gate rules 4 and 5)
- `identity.ts` — name parsing, owner titles, role/freemail/junk-domain classification, email pattern construction
- `crawl.ts` — 3-page site crawler and the "does this name appear on the site" check
- `llm.ts` — Anthropic calls, all using structured outputs (`output_config.format`)
- `provider.ts` — Hunter / Apollo domain lookup, on our key
- `dns.ts` — MX check over DNS-over-HTTPS
- `verifalia.ts` — batch verification, returning classification **and** status (catch-all detection)
- `gate.ts` / `finalize.ts` — the hard gate, and the single place that applies it
- `apify.ts` / `spend.ts` — actor runs, and per-campaign cost accounting

### Pipeline

Orchestrated by `campaign-orchestrator`, which routes on `campaigns.current_step`:

1. **Step 1** (`step1-scrape-businesses`) — Google Places Text Search + Place Details. Requests `formatted_address,address_components,types,business_status,user_ratings_total,editorial_summary` on top of name/phone/website, and **drops** anything not `OPERATIONAL`, outside the requested state/country, or whose `types` don't match the niche. Drop counts per reason go to the log and `stat_dropped_step1`. Checkpoints every 25 rows, then chains to step 2.
2. **Step 2** (`step2-enrich-contacts`) — starts Apify Actor 1 and returns. `current_step = 20` means "Apify in flight."
3. **Actor 1** (`apify-webhook`) — records general inboxes into `leads.email` and any owner-titled enrichment record as an **unverified** owner hint. It no longer decides whether an address is sendable.
4. **Owner lookup** (`owner-lookup`) — `current_step = 21`. The stage that answers "which human runs this business, and what mailbox reaches them?" Per lead, cheapest strategy first: an actor-1 hint → site crawl + Haiku extraction → data provider → model proposal corroborated against the site. Then constructs candidate addresses for anyone named but mailbox-less, and verifies the whole batch through Verifalia in one job. Batches of 10, self-chains, claims through a stale lease.
5. **Actor 2** (`apify-webhook`) — one more pass for general inboxes only, then finalize.
6. **Finalize** (`_shared/finalize.ts`) — applies the gate to every lead, writes `gate_passed`/`reject_reason`, sets `stat_owner_ready`, and picks `completed` vs `completed_low_yield`.
7. **Export** (`campaign-export`) — writes **two** CSVs: gate-passing rows, and a `-rejected.csv` with `reject_reason`. Both as 1-hour signed URLs.

**Actor 3 has been removed.** Its Apollo.io credentials were baked into the rented actor, returned 401 on every call, and produced nothing. Owner discovery is `owner-lookup`'s job; provider lookup now runs on our own `HUNTER_API_KEY` / `APOLLO_API_KEY`.

### The gate

A lead reaches the main CSV only if **all** of these hold. Anything else goes to the rejected bucket with a reason — never into the main export.

1. `owner_first_name` is a single letters-only token, 2–20 chars, and not a company/role/department word.
2. `owner_email` is present, is not a role inbox (`info@`, `hello@`, …), is not freemail unless the business runs on freemail *and* the local part contains the owner's name, and Verifalia classified it **exactly** `Deliverable` — no Risky, no Unknown, no catch-all.
3. The website domain has MX and is not a placeholder (`godaddy.com`, `mysite.com`, `wixpress.com`, …).
4. The Place Details address is inside the requested state/country.
5. The Place Details `types` match the niche's allowed types.

Two rules the code depends on:
- **`email_status` is the classification of `owner_email` only.** General inboxes go to `email` and are deliberately *not* Verifalia-verified — they never satisfy the gate, so a credit spent on one buys nothing.
- **Verification failure is fatal for the row, not ignorable.** Rows with no verdict are parked `pending_verify = true`; the watchdog re-queues them (bounded by `verify_attempts`, max 3). Saving unverified addresses is what produced the 6.4% bounce rate this design replaced.

### Reliability

Because the waterfall advances only on inbound webhooks, a dropped callback or hung actor would otherwise strand a campaign in `running` forever. Three mechanisms prevent that:

- **`claim_campaign_step(uuid, int, interval)`** — atomic step claim with a stale lease. A live step renews its lease through the `campaigns_updated_at` trigger and can't be taken over; a dead one becomes claimable after 3 minutes. Step functions must claim through this, never with an ad-hoc status filter.
- **`campaign-watchdog`** — runs every 5 minutes via pg_cron. For stale campaigns it polls the real Apify run and either replays the missed webhook, aborts runs past a 45-minute cap, or closes the campaign out keeping partial data. A stale `current_step = 21` re-kicks `owner-lookup` instead. Accepts `{campaign_id}` to reconcile one campaign on demand — and on an *already-finished* campaign that call re-runs the gate, which is how a campaign completed before the gate existed gets re-judged without re-scraping.
- **Run timeouts** — every actor is started with `?timeout=2700`; the Apify default is 7 days.
- **Owner-lookup lease** — `owner-lookup` self-chains with `{chained: true}`, which claims freely. Any other caller (watchdog, Resume) can only take over a step-21 campaign whose `updated_at` is older than 3 minutes, so a watchdog kick can't run a second batch alongside a healthy one and double the model/verification spend.

Status transitions belong to the orchestrator. The frontend passes `{ campaign_id, resume: true }` and must **not** write `status` itself first — doing so previously raced the claim guards and made Resume a silent no-op.

### Database Schema

Three tables with RLS enabled (users see only their own data):
- **campaigns** — status (`pending|running|paused|completed|failed|completed_low_yield`), `current_step` (**20 = Apify in flight, 21 = owner lookup in flight**, 6 = done), `step1_done`/`step2_done` counts, `stat_owner_ready`/`stat_rejected`/`stat_dropped_step1`/`stat_owners`/`stat_emails`, `spend_estimate_usd`/`spend_detail`, and `apify_run_id`/`apify_phase` for watchdog reconciliation
- **leads** — business/place fields (name, phone, website, place_id, city, `state`, `country`, `formatted_address`, `place_types`, `business_status`, `rating_count`, `editorial_summary`), owner identity (`owner_first_name`, `owner_last_name`, `is_doctor`, `title`, `owner_source`), deliverability (`owner_email`, `email`, `email_status`, `email_verifalia_status`, `mx_ok`, `domain_catch_all`, `pending_verify`, `verify_attempts`) and the gate verdict (`gate_passed`, `reject_reason`) + campaign FK
- **campaign_logs** — real-time execution log entries (level: info/success/warning/error, step number, message)

`add_campaign_spend(uuid, jsonb, numeric)` accumulates cost counters atomically — `owner-lookup` self-chains and runs leads in parallel, so a read-modify-write from Deno would lose updates.

**`completed_low_yield`** is a terminal *success* state: the run worked, but under 25% of scraped businesses produced a mailable owner. The UI shows it amber with a "do not upload this list" warning.

Realtime is enabled on all three tables — the frontend subscribes to Postgres changes for live updates.

### Environment Variables

Frontend (prefix `VITE_`):
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Edge Functions (set in Supabase secrets):
- `GOOGLE_MAPS_API_KEY` — Google Places Text Search + Place Details
- `ANTHROPIC_API_KEY` — city expansion and location scope in step 1, owner extraction in `owner-lookup` (all `claude-haiku-4-5-20251001`, all via structured outputs). Without it the site-crawl and model-proposal owner strategies are skipped and logged.
- `APIFY_API_KEY` — actors 1 and 2
- `VERIFALIA_USERNAME`, `VERIFALIA_PASSWORD` — deliverability verification. **Without these no row can pass the gate** — every candidate is parked `pending_verify`.
- `HUNTER_API_KEY` *or* `APOLLO_API_KEY` — optional provider owner lookup (`owner-lookup` stage b). Neither is currently set, so that stage skips and logs a warning; owners come from the site crawl only.

`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` appear in `.env` but **no code reads them** — there are no completion notifications.

Supabase Vault (used by the pg_cron watchdog job, not by the functions):
- `project_url`, `service_role_key`

### Styling

Tailwind CSS with a custom sky-blue brand palette (`#0ea5e9`). Dark theme throughout. Custom scrollbar utilities in `src/index.css`.

### Deployment

- Frontend → Netlify (SPA redirects configured in `netlify.toml`)
- Backend → Supabase Cloud (Edge Functions + PostgreSQL + Storage)
