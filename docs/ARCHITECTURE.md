# LeadGen v2 — Architecture

Status: **Phase 0 (audit + plan).** Nothing in this document is built yet. Where a claim
here was verified against a live endpoint, it is marked ✅ **verified** with the date;
where it is a design intention, it is marked ▢ *planned*. Verification date: 2026-08-16.

---

## 1. Why v2 exists

v1 works, and its quality gate is sound. What is broken is *where it runs* and *how much
it can see*.

**Runtime.** Every stage is a Supabase Edge Function with a wall clock. The pipeline
advances only when an inbound Apify webhook arrives. A dropped callback strands a
campaign in `running` forever — one sat there for 43 days. Three mechanisms were bolted
on to survive this (`claim_campaign_step` stale leases, a pg_cron watchdog, actor run
timeouts). They work, but they are compensating controls for an architecture that cannot
hold a long-running job. `owner-lookup` self-chains through HTTP calls to itself in
batches of 10 with a 90-second soft deadline; that is a queue, badly, over HTTP.

**Coverage.** One channel — Google Maps. A niche with no Maps presence (SaaS, agencies,
ecommerce brands) is invisible. Owner names come from a 3-page site crawl and, in
principle, a data provider — except neither `HUNTER_API_KEY` nor `APOLLO_API_KEY` is set,
so in practice owners come from the crawl alone. That is why the last run named 23/50 and
passed 5/50.

**Cost model.** Per-lead SaaS fees on every axis: Apify actor runs, Verifalia credits,
Google Places calls. The rented Apify actors are also opaque — Actor 3's Apollo
credentials were baked into someone else's actor and 401'd on every call.

v2 keeps the gate, keeps Supabase for auth/DB/Realtime/Storage, keeps the React frontend,
and moves all heavy work into a worker fleet on owned hardware talking to the same
Postgres.

---

## 2. Target architecture

```
┌────────────────────────────┐         ┌──────────────────────────────────────┐
│  Frontend (React + Vite)   │         │        Postgres (Supabase)           │
│  — Netlify                 │◄───────►│                                      │
│  campaigns / leads / jobs  │ Realtime│  auth · RLS · Realtime · Storage     │
│  live funnel · evidence    │  + RPC  │                                      │
│  dead-letter · retry       │         │  graphile_worker.jobs  ◄── queue     │
└────────────────────────────┘         │  job_runs · dead_letter              │
                                       │  businesses · people · contacts      │
                                       │  registry_entities · domain_patterns │
                                       │  serp_cache · tech_stack             │
                                       │  source_costs · verifier_ip_state    │
                                       └───────────────┬──────────────────────┘
                                                       │ pgbouncer (txn pool)
                                                       │ LISTEN/NOTIFY + poll
                        ┌──────────────────────────────┴───────────────────────────┐
                        │        Worker fleet — Docker on owned Linux servers       │
                        │        (graphile-worker; scale by replica count)          │
                        ├───────────────────────────────────────────────────────────┤
                        │  maps-worker      gosom/google-maps-scraper  (Go)         │
                        │  serp-worker      SearXNG JSON API                        │
                        │  crawl-worker     crawl4ai / Playwright                   │
                        │  linkedin-worker  StaffSpy, aged accounts, sticky proxy   │
                        │  registry-worker  Socrata / Sunbiz bulk / OpenCorporates  │
                        │  enrich-worker    name split · patterns · webappanalyzer  │
                        │  verify-worker    Reacher (own IPs) → Verifalia fallback  │
                        │  scheduler        cron enqueue + in-queue watchdog        │
                        └───────────────────────────────────────────────────────────┘
                                                       │
                        ┌──────────────────────────────┴───────────────────────────┐
                        │  Side services (same compose file, own containers)       │
                        │  pgbouncer · reacher · searxng · crawl4ai · playwright   │
                        └───────────────────────────────────────────────────────────┘
                                                       │
                                            ProxyPool  │  decodo_residential (sticky/rotating)
                                                       │  datacenter (server IPs)
                                                       │  none
```

**Adjustments from the brief's diagram**, each justified below in §7:

- The watchdog is *not* only "inside graphile". graphile-worker retries a job that
  *fails*; it cannot see a campaign whose jobs all succeeded but which never got
  enqueued for its next stage. A separate `campaign-reconcile` job runs on a cron
  schedule and re-derives what each campaign still owes. This is the one lesson from v1
  worth carrying over verbatim.
- `reacher` is drawn as a side service, not a worker. It is a third-party Rust binary we
  call over HTTP; `verify-worker` is our code that talks to it, applies throttling, IP
  rotation and cooldown, and falls back to Verifalia.
- Postgres is reached through **pgbouncer in transaction pooling mode** — but
  graphile-worker needs `LISTEN/NOTIFY`, which transaction pooling breaks. Workers
  therefore hold **two** connection strings: a session-mode connection for the queue's
  listener, and the pooled one for everything else. This is a real constraint that has
  bitten people; it is called out in `.env.example` in Phase 1.

---

## 3. Queue and job model

**graphile-worker** ✅ verified — `graphile/worker`, MIT, 2.4k stars, last push
2026-08-06, actively maintained. Postgres-native, no Redis, retries with exponential
backoff, `job_key` dedupe, cron built in.

Every stage is a job type. Every job writes one row to `job_runs`:

```
job_runs(id, campaign_id, lead_id, stage, status, attempt,
         error, started_at, finished_at, cost_cents)
```

Idempotency: `job_key = '{campaign_id}:{lead_id}:{stage}'`. Re-enqueueing a job that is
already queued replaces it rather than duplicating it, so a "retry all failed" click from
the UI cannot fan out into double spend.

After N retries a job lands in `dead_letter` with its last error and full payload, and
becomes visible in the UI with a one-click requeue.

**Why this replaces three v1 mechanisms at once:** `claim_campaign_step`'s stale lease
becomes graphile's job locking; the self-chaining HTTP loop in `owner-lookup` becomes
"enqueue one job per lead"; the actor run timeout becomes a job timeout.

---

## 4. Sources

Each source implements one interface, reports its own cost, and is independently
enable-able per campaign:

```ts
interface Source {
  name: string
  discover?(query: DiscoverQuery): AsyncIterable<BusinessCandidate>
  enrich?(lead: Lead): Promise<EnrichmentResult>
  costPerUnit(): CostEstimate        // proxy GB + API + LLM
}
```

### A. Google Maps — `gosom/google-maps-scraper`
✅ verified — MIT, 5.5k stars, last push 2026-08-06, release v1.17.3 (2026-07-26), Go.
Self-hosted, headless, exposes a web/API mode. Runs through Decodo residential.
Google Places API is retained **only** as a fallback for `place_id` resolution, on the
existing `GOOGLE_MAPS_API_KEY`.

Location expansion keeps v1's `expandLocation`; `state`/`country` are still extracted
from the address and hard-filtered.

### B. State business registries
The owner-name source for brick-and-mortar. **Bulk/open data first, scraping second.**

| State | Source | Status |
|---|---|---|
| NY | data.ny.gov `n9v6-gdp6` "Active Corporations: Beginning 1800" (Socrata) | ✅ verified live, 4,266,351 rows |
| CO | data.colorado.gov `4ykn-tg5h` business entities (Socrata) | ✅ verified live |
| FL | Sunbiz quarterly bulk via `sftp.floridados.gov` | ✅ page + SFTP host verified |
| CA/TX/WA/other | OpenCorporates API, generic adapter | ⚠️ see §8 — no longer free |

**NY field reality** (measured 2026-08-16, whole dataset):

| Field | Populated |
|---|---|
| `dos_process_name` | 4,194,633 (98.3%) |
| `registered_agent_name` | 870,927 (20.4%) |
| `chairman_name` (labelled "CEO Name") | 473,947 (11.1%) |
| `location_city` | 355,413 (**8.3%**) |

Two consequences the brief's plan has to absorb:

1. **The name goldmine is `dos_process_name`, not the CEO column.** On a representative
   sample of 800 Long Island wellness/aesthetic/med-spa entities: `chairman_name` is
   person-shaped 10.1% of the time, `dos_process_name` 35.5%, `registered_agent_name`
   12.6% — **49.4% have a person-shaped name in at least one field.** But 53–56% of
   `dos_process_name` values are just the entity name repeated, and others are commercial
   agents (CT Corporation, Spiegel & Utrera, …), so the adapter must classify
   person-vs-company per field. v1's `parseName` + `NON_PERSON_TOKENS` is exactly the
   right tool and is being ported for this.
2. **Matching cannot key on city.** `location_city` is 8.3% populated;
   `dos_process_city` is 99.8%. Matching keys on normalised name + county (100%
   populated) with `dos_process_city`/ZIP as tie-break, *not* name+city as the brief
   assumed.

Matching: normalise (strip LLC/Inc/PC/DBA, punctuation, city suffix), `pg_trgm`
similarity ≥ 0.6, tie-break on ZIP/street, emit `officer_name`, `officer_title`,
`entity_type`, `incorporation_date`, `match_confidence`. A registry-confirmed officer is
the highest-trust name source.

Per-source URLs and refresh cadence land in `docs/registries.md` in Phase 3.

### C. Website crawl — crawl4ai
✅ verified — Apache-2.0, 78.3k stars, last push 2026-08-15, v0.9.2. Via Decodo.
Home + `/about /team /our-team /meet-* /staff /founder /contact`, cap 6 pages / 2 MB
(v1 capped at 3 pages / 400 KB — the widening is deliberate).
Extraction with `claude-haiku-4-5-20251001` in strict JSON with confidence, plus regex
and `mailto:` scraping. Tech stack via `enthec/webappanalyzer` ✅ verified (GPL-3.0,
561 stars, last push 2026-08-12) → `tech_stack[]`.

### D. LinkedIn
⚠️ **Both libraries named in the brief have problems** — see §8. Plan: StaffSpy behind
Decodo sticky sessions with an aged-account pool, hard rate limits (≤80 profile
views/account/day, jittered), rotation, backoff on 999/429, `cooling` on challenge.
SERP fallback via SearXNG when no account is available. Persist to `people` keyed on
`linkedin_url` so repeat campaigns are free.

### E. SERP — SearXNG
✅ verified — AGPL-3.0, 35.5k stars, last push 2026-08-16 (today). Self-hosted, JSON API,
via Decodo. Every query cached in `serp_cache` for 30 days. Discovery adapters for
G2/Capterra/ProductHunt/YC over public listing pages, one adapter each behind the same
`Source` interface.

### F. Email finding + verification
See §5.

---

## 5. Verifier strategy (hybrid)

```ts
interface VerifierProvider {
  verify(emails: string[]): Promise<VerifyResult[]>
  // {email, status: safe|invalid|risky|unknown, is_catch_all, is_disposable,
  //  is_role, provider, latency_ms, cost_cents}
}
```

`VERIFIER=reacher|verifalia|hybrid`, default `hybrid`. Verifalia's v2.5 client moves
behind this interface unchanged — it is good code and it is the safety net.

**Reacher** ✅ verified — `reacherhq/check-if-email-exists`, 9.5k stars, last push
2026-03-17, v0.11.7. The standalone `reacherhq/backend` repo is **archived** (Dec 2024)
because the HTTP backend was merged into the main monorepo (`backend/` directory is
present). Docker image `reacherhq/backend:v0.11.7` published 2026-01-15 ✅ verified on
Docker Hub. So the self-hosting path is alive — but see the licensing warning in §8.

Hygiene (non-negotiable): dedicated IPs in `REACHER_IPS`, each with PTR/rDNS and SPF,
`REACHER_HELO_DOMAIN` a domain we own that is **not** a cold-email sending domain.
Per-MX throttle: 1 connection, ≤5 RCPT/session, 3–5 s gaps, ≤150 checks/hour/IP toward
Gmail and Microsoft, ≤400/hour/IP elsewhere. Round-robin IP rotation.

Auto-cooldown: on 421/450/451/4.7.x/5.7.1, or "blocked/blacklisted/spamhaus" in the
banner, the IP is marked `cooling` for 24 h in `verifier_ip_state`, logged, surfaced in
the UI. Its share routes to other IPs; if **all** IPs are cooling, route to Verifalia.

Hybrid routing: (1) Reacher first for everything; (2) `unknown`/`risky` on a Tier-B
candidate → second opinion from Verifalia; (3) never send `invalid` or `safe` to
Verifalia; (4) hard cap `VERIFALIA_MAX_CENTS_PER_CAMPAIGN` (default 500) — on exhaustion
keep the Reacher verdict and flag `verifier_budget_exhausted`.

Caching: email verdict 30 days, domain catch-all 7 days, `domain_patterns` forever.
Only leads that already have a name are verified.

**Tiering** replaces v1's binary gate:

| Tier | Rule |
|---|---|
| A | Verified `safe` |
| B | Catch-all domain, score ≥ 55 |
| C | Everything else that has a name |
| rejected | No name, or no domain |

Score: +40 name from registry or LinkedIn · +25 name from site with owner title ·
+20 pattern matches a known pattern on that domain · +10 email seen on site/mailto ·
+10 LinkedIn profile links to that domain.

**This is the biggest behavioural change from v1 and it is deliberate.** v1 rejected
every catch-all domain outright — 12/50 domains on the last run were catch-all, and 52%
of *named* leads died there. Tier B recovers those as a separately-exported, clearly
labelled bucket rather than silently mixing them into the main CSV.

---

## 6. Data model

New tables alongside the existing three:

| Table | Dedupe key | Purpose |
|---|---|---|
| `businesses` | normalised domain, else name+phone | the deduped entity |
| `people` | `linkedin_url`, else name+domain | reusable across campaigns |
| `contacts` | person ↔ business | email, tier, score, `sources[]` |
| `registry_entities` | state + entity id | officer names from bulk data |
| `domain_patterns` | domain | learned email pattern, kept forever |
| `serp_cache` | query hash | 30-day SERP cache |
| `tech_stack` | domain | webappanalyzer output |
| `job_runs` | — | per-job execution record + cost |
| `dead_letter` | — | jobs past max retries, requeueable from UI |
| `source_costs` | campaign + source | yield and spend per source per stage |
| `verifier_ip_state` | ip | `cooling` state and expiry |

Every lead row keeps `sources[]` and `evidence jsonb` — the URLs and snippets supporting
each field — so any row is auditable from the UI. All tables are per-user via RLS, as
today.

---

## 7. What survives from v1

The gate logic is the most valuable thing in the repo and nearly all of it ports.

### Ported essentially as-is (TypeScript → worker package)

| File | Lines | Notes |
|---|---|---|
| `_shared/identity.ts` | 266 | Name parsing, owner titles, role/freemail/junk-domain classification, pattern construction. The single best asset in the codebase. Extends directly to the registry person-vs-company problem in §4B. |
| `_shared/geo.ts` | 270 | Location scope resolution, address facts, ccTLD check. |
| `_shared/niche-types.ts` | 146 | Niche → Place-type rules. |
| `_shared/owner-patterns.ts` | 270 | `expandLocation` metro/state maps. |
| `_shared/dns.ts` | 74 | DoH MX check with dual resolver and memo. |
| `_shared/verifalia.ts` | 159 | Moves behind `VerifierProvider` as the fallback. |
| `_shared/crawl.ts` | 177 | `htmlToText` and `nameAppearsInText` survive; the fetch loop is replaced by crawl4ai. |
| `_shared/llm.ts` | 184 | Structured-output Anthropic calls + schemas. |
| `_shared/gate.ts` | 121 | Becomes the Tier-A rule inside the new scorer. |
| `_shared/gate_test.ts` | 171 | First tests to port to Vitest. |

### Rewritten

| v1 | v2 |
|---|---|
| `step1-scrape-businesses` (319) | `maps-worker` over gosom scraper; Places API demoted to `place_id` fallback |
| `owner-lookup` (509) | split into `crawl-worker` / `registry-worker` / `linkedin-worker` / `enrich-worker`; the self-chaining batch loop is deleted outright |
| `_shared/finalize.ts` (142) | becomes the tiering + scoring pass |
| `campaign-orchestrator` (115) | graphile job graph |
| `campaign-watchdog` (256) | `campaign-reconcile` cron job (§2) |
| `campaign-export` (124) | per-tier CSV/JSON export + webhook out |
| `_shared/spend.ts` (64) | `source_costs` + `job_runs.cost_cents`, incl. proxy GB |

### Deleted

| What | Why |
|---|---|
| `_shared/apify.ts`, Actor 1 (`vdrmota~contact-info-scraper`), Actor 2 (`fatihtahta~email-scraper-deep`) | per-lead SaaS fee for work crawl4ai does on our own hardware; opaque rented actors |
| `apify-webhook` (243) | webhook-driven advancement is the root cause of the stranding bugs |
| Actor 3 (`fatihtahta~waterfall-contact-enricher`) | already removed in v1 — baked-in Apollo credentials, 401 on every call |
| `_shared/provider.ts` (143) | Hunter/Apollo were never configured; registry + LinkedIn + SERP replace them. Keep the file only if a Hunter key is ever purchased. |
| `APIFY_API_KEY`, `apify_run_id`, `apify_phase` | no Apify |
| `claim_campaign_step` stale-lease RPC | graphile job locking |
| `campaigns.current_step` 20/21 sentinels | job states, not magic integers |

### Kept unchanged
Supabase auth, RLS, Realtime, Storage. The React frontend shell, routing, `useAuth`,
Tailwind theme. `campaigns` / `leads` / `campaign_logs` tables (extended, not replaced).

---

## 8. Verified risks — things that are not as the brief assumes

Listed here rather than discovered in Phase 3.

**1. Reacher is AGPL-3.0 or paid-commercial. ✅ verified from `LICENSE.md`.**
> "If you want to use `check-if-email-exists` to develop commercial sites, tools, and
> applications, the Commercial License is the appropriate license… If you are creating an
> open source application under a license compatible with the GNU Affero GPL license v3,
> you may use `check-if-email-exists` under the terms of the AGPL-3.0."

This product is a commercial SaaS. Self-hosting AGPL software that users interact with
over a network triggers AGPL §13 — the obligation to offer the corresponding source of
the combined work to those users. The zero-per-lead-fee goal collides with the licence
here, and this is a decision for you, not a technical detail I should pick a side on.
Options: (a) buy the Reacher commercial licence — still far cheaper per check than
Verifalia at volume; (b) keep Verifalia as the primary verifier and drop Reacher;
(c) accept AGPL obligations. **This blocks the Reacher half of Phase 1 until you choose.**

**2. `tomquirk/linkedin-api` returns 404 — the repo is gone.** ✅ verified. The brief
names it as the LinkedIn fallback. A search of the top `linkedin-api` repos turns up no
maintained drop-in: the best-starred alternatives were last pushed 2023–2024, and the
official `linkedin-developers` clients only expose the partner API, which does not do
people search. Plan: StaffSpy as primary, SERP-via-SearXNG as the real fallback, and no
second unofficial library.

**3. StaffSpy is thinly maintained.** ✅ verified — 325 stars, WTFPL, last push
2025-06-17 (14 months ago), last release v0.2.24 (2025-01-01). LinkedIn changes its
internals frequently; a 14-month-old scraper is likely to need patching on day one.
Phase 4 must budget for forking it. If it fails its smoke test, SERP-only LinkedIn
discovery is the honest fallback and I will say so rather than claim a working
integration.

**4. OpenCorporates no longer has an open free API tier.** ✅ verified — the API
returns `401 Invalid Api Token`, and the API-account signup page now redirects to
`/pricing/`. The brief's "free tier + cache" generic adapter needs either a paid plan or
replacement by direct per-state bulk sources. Recommendation: expand direct state
adapters (NY/FL/CO already confirmed) and treat OpenCorporates as optional.

**5. Phase 3's "≥70% named for NY brick-and-mortar" is unlikely from registry alone.**
Measured ceiling is 49.4% person-shaped names on the target population *before* any
match losses — and matching Maps names ("Radiance Med Spa") to registry names
("RADIANCE MEDICAL AESTHETICS LLC") will lose more, with DBA/trade names absent from the
dataset entirely. Registry realistically contributes 35–45% named. 70% is reachable only
as the **union** of registry + site crawl + LinkedIn + SERP. I will report the per-source
contribution separately so the number is not a black box.

**6. pgbouncer transaction pooling breaks graphile-worker's LISTEN/NOTIFY.** Workers
need both a session-mode and a pooled connection string. Called out here so it is
designed in, not debugged later.

**7. The repo is not under version control, and `.env` holds live secrets.**
`git status` → "not a git repository". `.gitignore` contains only `.netlify`, so `.env`
(Google Maps, Anthropic, Apify, Verifalia, OpenAI keys) would be committed on the first
`git init && git add .`. Recommended before any Phase 1 code lands: `git init`, a real
`.gitignore`, and rotation of anything already exposed.

---

## 9. Cost and scale targets

Reported against these at the end of every phase:

- ≤ $0.02 per scraped business
- ≤ $0.10 per Tier-A lead all-in (proxy GB + Haiku + server share)
- 10k businesses/hour discovery
- 2k Reacher checks/hour per IP without blocks (throttled per MX)
- Haiku ≤ 1 call/lead/stage, cached by URL hash

---

## 10. Phase order

| Phase | Deliverable |
|---|---|
| 0 | **this document** + audit + migration plan |
| 1 | docker-compose, graphile-worker, `job_runs`/`dead_letter`, ProxyPool, Reacher self-test, Verifalia parity test, cooldown unit tests, SearXNG, `.env.example` + env table |
| 2 | Sources A + C + F end-to-end; 100 med spa / Long Island NY |
| 3 | registry-worker (NY + FL + CO), name matching; re-run the same 100, report delta |
| 4 | LinkedIn + SERP + SaaS discovery; 100 practice-management SaaS / US |
| 5 | UI/reliability, Vitest + Playwright, `docs/RUNBOOK.md`, 1,000-lead runs + cost report |
