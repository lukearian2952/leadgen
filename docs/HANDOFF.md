# LeadGen v2 — Handoff

State as of 2026-08-18. Written so someone else (or me, later) can pick this up
without re-deriving anything. `ARCHITECTURE.md` is the design, `MIGRATION.md`
the v1→v2 plan; this file is **what is actually true right now**.

**One-line status:** the pipeline is built, measured and proven at scale. A
1,000-business national run completed in **1.75 hours for $6.88 ($0.0066 per
business), zero failed jobs and zero dead-letters**, at **1.47 MB of residential
proxy per business**. The engineering is not the constraint. **Yield is**, and
§7 says exactly where it goes.

---

## 1. What the pipeline does

```
maps:discover ──▶ crawl:site ──▶ registry:match ──▶ [serp:owner] ──▶ enrich:lead
   (batched)       (name+email)    (name, both        (name, only      (mailbox,
                                    directions)        when it helps)   verify, tier)
                                                                            │
                                                  campaign:reconcile ◀──────┘
```

Discovery is **batched and sequential** — `MAPS_MAX_QUERIES` (36) per job, each
enqueuing its successor. gosom falls over past a few dozen concurrent Maps
searches, so more queries at once is strictly worse than more batches.

Every lead ends in a tier: **A** (verified deliverable), **B** (sendable with a
labelled caveat), **C** (named, not deliverable), **rejected**.

---

## 2. Stack state

### Server
`srv607166` / `92.112.184.200`, Ubuntu 24.04.3, 4 cores, 15 GB RAM.
Deployed at `/opt/leadgen` (rsynced from the Mac; **not** a git checkout).

**The box also runs unrelated production workloads** — Odoo ×2, n8n ×2,
narrative-radar, 3 Postgres, 1 Redis, nginx. Ports 22/80/443/3000/5432/5678/
5679/8069/8070/9120/9209 are theirs and must not be touched.

### Containers (12 running)

| Service | Port | mem | Notes |
|---|---|---|---|
| verify-svc | :8080 | 256m | `network_mode: host`, required to bind `VERIFY_IPS`. **Firewalled** — §3 |
| **proxy-meter** | 127.0.0.1:8090 | 256m | **Counts, blocks and budgets all Maps residential traffic.** §6 |
| searxng | 127.0.0.1:8888 | 512m | JSON API. Used by `serp:owner` and address discovery |
| crawl4ai | 127.0.0.1:11235 | 2g | up; **still no job calls it** — the crawl fetches directly |
| maps-scraper | 127.0.0.1:8085 | 512m | gosom; egresses through proxy-meter |
| maps-worker | 127.0.0.1:9101 | 512m | |
| crawl-worker | (scaled) | 512m | |
| registry-worker | 127.0.0.1:9105 | 512m | |
| serp-worker | 127.0.0.1:9102 | 512m | |
| enrich-worker | 127.0.0.1:9106 | 512m | |
| verify-worker | 127.0.0.1:9107 | 512m | Also serves `POST /feedback/mailbox` |
| scheduler | 127.0.0.1:9108 | 512m | `campaign:reconcile`, singleton — **never scale** |

`docker compose up -d` from `/opt/leadgen`. Each worker builds its own image, so
`docker compose build` (no service arg) is needed after a code change or older
images silently keep running.

### Database
Supabase `paasggeawsoctfgqbqrd`, Postgres 17. Migrations applied through
**`20260817000004_discovery_bytes`**:

| Migration | Adds |
|---|---|
| `…0003_worker_queue` | `job_runs`, `dead_letter`, `source_costs`, `verifier_ip_state`, pg_trgm |
| `…0004_phase2_entities` | `businesses`, `people`, `contacts`, `domain_patterns`, `serp_cache` |
| `…0005_alerts` | `alerts` + `raise_alert()` |
| `…0001_phase3_registry_serp` | `registry_entities`, `zip_county`, `leads.name_class/corroboration` |
| `…0002_phase4_mailbox` | `mailbox_feedback`, `domain_patterns.source`, officers GIN index |
| `…0003_preflight` | `preflight_runs`, `niche_calibration` |
| `…0004_discovery_bytes` | `discovery_city_runs`, `campaigns.residential_budget_bytes` |

**v1's pg_cron watchdog stays unscheduled.** `select count(*) from cron.job` = 0.
Verify before every run — it once raced v2 and scraped 100 businesses through
the Places API into the same table.

### Connection budget — this is a hard ceiling
Supavisor allows ~15 session-mode clients project-wide; graphile-worker needs
session mode for `LISTEN/NOTIFY`. Each worker is capped at `maxPoolSize: 2`.
**Seven workers ≈ 14 slots is the ceiling.** An eighth crash-loops on
`EMAXCONNSESSION`, and so does an ad-hoc `psql`-style client while seven are up.

**Consequence for scripts:** use `DATABASE_URL` (transaction pooler, :6543), and
enqueue jobs with `graphile_worker.add_job` in SQL rather than
`makeWorkerUtils`. Every script in `workers/scripts/` does this.

`db.<ref>.supabase.co` is **AAAA-only**; both URLs must use the pooler hostname.

---

## 3. Security

`verify-svc` binds `0.0.0.0:8080` because host networking is required for
outbound IP binding. It **was reachable from the internet with no
authentication** — anyone could drive `POST /verify` and burn our IP's
reputation, the one asset the verification design rests on.

Closed in `e20b5e6`: a `LEADGEN-FW` iptables chain entered only for `tcp dport
8080`, returning for loopback and RFC1918-on-a-bridge and dropping everything
else, on **both address families**. Installed as `leadgen-firewall.service`;
script at `infra/leadgen-firewall.sh`, idempotent.

Every other LeadGen port is `127.0.0.1:port`. **Any new service must follow that
pattern or get a rule.** `proxy-meter` and the feedback endpoint both do.

Testing note: `nc` from outside reports 8080 as "connected". Hostinger's edge
terminates inbound TCP — a port with nothing listening *times out* rather than
refusing. Only "does application data flow" is a valid test from off-box.

---

## 4. Environment variables

`workers/src/config.ts` is the source of truth and refuses to boot when a
required var is missing. `workers/test/config.test.ts` asserts the list stays in
sync. Full table in `docs/ENV.md`.

**`.env` values must be double-quoted when they contain shell metacharacters.**
Three passwords contain `(`, `)` or `'`; unquoted they silently abort
`set -a; . ./.env` partway and every variable after `VPS_PASSWORD` goes missing.
After any `.env` edit, confirm the *last* variable still reads.

### Flags that change behaviour, and their measured defaults

| Variable | Default | Why |
|---|---|---|
| `MAPS_MAX_QUERIES` | 36 | gosom degrades badly past a few dozen concurrent searches |
| `MAPS_DEPTH` | 5 in compose, **run at 10** | every accepted byte figure was measured at depth 10 — see §8.2 |
| `MAPS_WAIT_MINUTES` | derived: 30 s/query, 20–45 min | a fixed cap killed two good scrapes |
| `MAPS_SCRAPER_EMAIL` | `false` | gosom re-crawled every business site through residential to duplicate `crawl:site` |
| `MAPS_PROXY_METER_URL` | `http://proxy-meter:8090` | all Maps egress is metered |
| `METER_BLOCKING` | `true` | blocks tiles, fonts, photos, analytics, site-builder CDNs |
| `METER_BLOCK_GSTATIC` | `false` | **unresolved** — see §8.1 |
| `METER_BUDGET_BYTES` | 0 (unlimited) | set per run; 2.5 GB was used for the 1,000 |
| `PATTERN_LADDER_EXTRAS` | `false` | measured as zero recovery for 2.6× the verification spend |
| `REGISTRY_REVERSE_STATEWIDE` | `true` | +1 name per ~100 lookups, 0 false positives |
| `STALE_LOCK_MINUTES` | 60 (floor 50) | must exceed the longest job; below the floor it throws |
| `VERIFIER` | `verifalia` | port 25 is blocked upstream — §9.1 |

### Still not set
- **`SOCRATA_APP_TOKEN` is empty** in both `.env` files and in the container.
  Every registry ingest has run on the shared anonymous pool: it completes, but
  slower and with retry backoff. Free from `evergreen.data.socrata.com/signup`.
- `LINKEDIN_ACCOUNTS` — Phase 5.

### Credential hygiene (outstanding)
`SUPABASE_ACCESS_TOKEN` was pasted into a chat transcript and **should be
rotated**. v1 keys in a pre-`git init` `.env`: `APIFY_API_KEY` should be revoked;
`OPENAI_API_KEY`, `GEONIX_API_KEY`, `TELEGRAM_*`, `VPS_SCRAPER_*`,
`GOOGLE_CSE_*` are read by no code and should be revoked rather than rotated.

---

## 5. Built and tested

**289 Vitest tests + 18 Go tests pass; `tsc --noEmit` clean.**
`cd workers && npm test`. Go: `docker run --rm -v /opt/leadgen/verify-svc:/src
-w /src golang:1.23-alpine sh -c "go mod tidy >/dev/null; go test ./..."`.

| Area | Proven behaviour |
|---|---|
| `prober` (Go, 18) | stop-at-first-safe = exactly one RCPT; catch-all short-circuit; policy-5xx ≠ invalid; MX backoff; IP cooling |
| `verify/*` | 24h cooldown, hourly caps, round-robin; the four hybrid routing rules; whole-batch reroute only when the primary **cannot run** |
| `name-class` | owner_grade / clinical_lead / staff; `PA` never matches "Spa Manager"; credentials read off the name when the title is blank |
| `name-decision` | usability before precedence; a source cannot corroborate itself; clinical promotion by each of the four routes |
| `registry-name` | entity-name-repeat, commercial agents, org markers; **FL fixed-width name split** |
| `fl-layout` | the 1,440-char record asserted against four unmodified live records |
| `freemail` | the four conditions; the eight real addresses the rule exists to recover |
| `pattern-discovery` | learns from a staff address; ignores role inboxes and other domains |
| `feedback` | idempotency, delivered/hard/soft semantics, scoped pattern retraction |
| `maps-wait` | ok-but-empty ≠ timeout; growth resets the stall clock; startup grace |
| `preflight` | census→band mapping, calibration ordering, insufficient-data honesty |

**Proven live:** graphile round-trip over Supavisor; Decodo sticky/geo exits;
gosom scrape → CSV → filtered leads; Verifalia verdicts with per-contact
provider attribution; alert dedupe; MX backoff and IP cooling on a real batch;
`POST /feedback/mailbox` including idempotent replay; proxy-meter counting and
blocking against live traffic.

---

## 6. proxy-meter — how Maps bytes are controlled

Every other egress goes through `ProxyPool`, which buffers each response and
counts exactly. gosom drives its own Chromium in a separate process and is
handed a proxy URL, so **the one stage with a browser in it was the one stage
never measured**. Decodo showing ~3 GB with no per-stage attribution was the
direct consequence.

`proxy-meter` sits between gosom and Decodo and does three jobs:

1. **Counts** bytes both directions, per upstream host, per batch.
   `maps:discover` resets it before a scrape and reads it after, attributing
   through the same `add_source_cost` path as every other stage.
2. **Blocks** hosts whose bytes we discard. gosom exposes no
   request-interception option — `-fast-mode` reduces *collection*, not
   transfer — so the proxy is the only place short of forking it. CONNECT only
   exposes `host:port`, but Google serves tiles, photos and fonts from
   dedicated hosts, so host-level blocking is coarse, sound and reversible.
3. **Budgets** — refuses new connections once the allowance is spent.

No dependencies: `node:net` and `node:http` are the whole implementation.

### Measured effect

| config | MB | businesses | MB each |
|---|---|---|---|
| baseline: no blocking, depth 10, gosom email on | 297.4 | 117 | **2.54** |
| blocking + `email: false`, depth 10 | 153.6 | 95 | **1.62** |
| **the 1,000-business national run** | **1,528.8** | **1,042** | **1.47** |

The two changes that did the work were host blocking (`fonts.gstatic.com` alone
was 50.6 MB over 183 connections) and turning off gosom's email crawl, which was
re-fetching every business website **through residential** to extract addresses
`crawl:site` already collects datacenter-first while also reading the page for
owner names.

---

## 7. The 1,000-business national run

Campaign `67aaaad4-c23a-44fc-9e94-e059e7470e00`, "car wrap" (+ "vehicle wraps",
"vinyl wrap") / "United States", target 1,000, 204 cities, 8 batches.

### Funnel

| | n | % |
|---|---|---|
| discovered | **1,042** | target exceeded |
| with a website | 947 | 90.9% |
| **named** | **193** | 18.5% |
| **Tier A** | **70** | 6.7% |
| **Tier B** | **53** | 5.1% |
| Tier C | 59 | 5.7% |
| rejected | 860 | 82.5% |
| **Tier A+B (sendable)** | **123** | **11.8%** |

Terminal status `completed_low_yield` — sendable share under the 25% threshold,
which is correct and expected for this niche.

**Tier B by reason:** `catch_all_named` 28 · `freemail_business_verified` 25.
**53 of 123 sendable rows exist only because of the two Phase-4 concessions.**

### Bytes per batch — the drift guard never tripped

| batch | discovered | MB | MB/discovered |
|---|---|---|---|
| 0 | 150 | 190.8 | 1.272 |
| 1 | 171 | 213.4 | 1.248 |
| 2 | 164 | 208.9 | 1.274 |
| 3 | 82 | 101.6 | 1.239 |
| 4 | 191 | 206.5 | **1.081** |
| 5 | 151 | 180.5 | 1.195 |
| 6 | 127 | 179.5 | **1.414** |
| 7 | 231 | 247.6 | **1.072** |

**1.53 GB of the 2.5 GB cap (61%).** Threshold was 2.0 for two consecutive
batches; the worst single batch was 1.414.

### Throughput and cost

| stage | jobs | failed | avg s | jobs/hr |
|---|---|---|---|---|
| `enrich:lead` | 1,160 | 0 | 0.54 | 719 |
| `registry:match` | 1,149 | 0 | 0.26 | 713 |
| `crawl:site` | 1,145 | 0 | 24.07 | 710 |
| `campaign:reconcile` | 83 | 0 | 2.51 | 53 |
| `maps:discover` | 8 | 0 | 540.21 | 7 |

**1.75 hours wall clock. Zero failed jobs, zero dead-letters.** Peak queue depth
274. **$6.88 total = $0.0066 per business**, against a ≤$0.02 target.
Verifalia 371.7¢ of the 3,000¢ cap (12.4%): 173 checks — 91 safe, 54 risky, 28
invalid.

### Residential by stage

| source | stage | MB | note |
|---|---|---|---|
| `google_maps` | maps | **1,528.8** | residential — 95% of the bill |
| `site_crawl` | crawl | 71.9 | residential, escalation only |
| `site_crawl:datacenter` | crawl | 938.6 | datacenter, **not billed** |

The datacenter-first crawl policy kept 938 MB off the meter entirely.

### Exports
`exports/car-wrap-united-states-tier_AB.csv` — **123 rows** (sendable)
`exports/car-wrap-united-states-tier_C.csv` — **59 rows** (low-volume segment)
`exports/` is gitignored; these are customer records.

### The caveat that matters most

**Named by source: `site_crawl` 185, `registry` 8.** On the 100-business Long
Island wrap run, registry named 19. Here it named 8 out of 1,042 — because
`registry_entities` holds **NY (95,866 across 63 counties) and CO (4,293, one
county) and nothing else**. For businesses in the other 48 states the forward
match and the reverse lookup had nothing to search.

**So 18.5% named is a floor, not the pipeline's ceiling.** Do not read this
run's named-rate as representative until §8.3 is done.

---

## 8. Open follow-ups

### 8.1 `www.gstatic.com` — unresolved, and the largest byte lever left
37 MB of the 154 MB a 95-business batch spent — **24% of remaining cost**.

**An earlier claim that blocking it returns zero businesses is retracted.** It
rested on a single run, and that run coincided with Decodo's traffic limit being
exhausted — every request was failing with `407 … reached your current traffic
limit` regardless of the block. A re-test with the block *disabled* failed
identically, which is what exposed the confound.

To settle it: **two runs with the flag on, two with it off, on a live upstream,
comparing row yield and not only bytes.** `METER_BLOCK_GSTATIC` exists for
exactly this. The mechanism is plausible — gosom parses the rendered DOM and
this host carries Google's shared JS bundle — but plausible is not measured.

### 8.2 Scroll depth 10 → 5 — never measured
`MAPS_DEPTH` defaults to 5 in compose, but **every byte figure in this document
was taken at depth 10**, including the 1,000-run's 1.47. Three attempts to
measure depth 5 all ran against the exhausted quota.

Depth cuts rows and bytes together, so it is not obviously a win on the *ratio*.
The question is whether later scroll pages cost the same per page while yielding
fewer new businesses. **Until measured, run at depth 10** so cost matches the
figures here rather than an untested one.

### 8.3 Registry coverage — the highest-value open item
NY and CO only. The FL adapter is **built and tested** (`workers/test/fl-layout.test.ts`
asserts the 1,440-char layout against real records, including the
`LAST`(20)+`FIRST`(14)+middle sub-fields the published spec omits and the
per-officer P/C flag it also omits) but **has never been ingested**.

Ingesting FL and CO properly, then adding states by population, is the cheapest
available increase in named-rate — registry led naming on dental (22 vs 8 site)
and tied on the Long Island wrap run (19/19). A national run currently gets
registry naming for 2 states out of 50.

### 8.4 LinkedIn + SaaS discovery — Phase 5, not started
The `linkedin-worker` role exists and is wired but registers no tasks, and it is
behind the `full` profile because **starting it makes eight workers and breaks
the connection ceiling** (§2). Something must be scaled down first.

`ARCHITECTURE.md` §8 records the two verified risks: `tomquirk/linkedin-api` is
gone (404), and StaffSpy is thinly maintained (325 stars, last push 2025-06-17).
Budget for forking it, and treat SERP-only LinkedIn discovery as the honest
fallback.

**SERP is off by default for brick-and-mortar niches** and on for unmatched
(online/SaaS) ones — it produced 2 usable names across 254 brick-and-mortar
businesses and 0 on both new niches. That default is measured, and SaaS is
exactly where it should earn its place.

### 8.5 UI — nothing built this phase
The React frontend still shows v1's campaign list and detail. Not updated for:
tiers (it renders `gate_passed`), `name_class`/`corroboration`, the preflight
census, per-campaign residential budget and spend, `discovery_city_runs`
progress, or the dead-letter requeue the architecture promises. The alert banner
component builds and is wired but **has never been seen with a live alert**.

---

## 9. Known external blockers

### 9.1 Port 25 dropped upstream
Root cause established by three independent methods (shell probes with a control
arm, packet capture, and the prober's own dialler). Port-specific, not
host-specific; provider-independent; both address families. Hostinger agrees it
is an upstream IP-specific egress filter. Evidence in
`docs/hostinger-evidence.txt`.

**Consequence:** `VERIFIER=verifalia`. Revert to `hybrid` when unblocked and
expect verify-svc to be the cheap path again.

### 9.2 Decodo traffic limit
Exhausted once mid-phase, which invalidated a measurement and cost several
hours (§8.1). The failure is a `407` with
`x-error-message: … reached your current traffic limit`. **A direct CONNECT test
distinguishes it from anything in our stack in one command** — do that first
when discovery returns zero bytes.

---

## 10. Operational traps — each of these cost real time

1. **Never restart a worker while `maps:discover` is in flight.** graphile holds
   the lock, and its own expiry is **4 hours**. Now mitigated by
   `releaseStaleLocks` at boot (§4, `STALE_LOCK_MINUTES`), but a restart still
   abandons the running scrape.
2. **`graphile_worker.jobs` does not expose `payload`** — it is on
   `_private_jobs`. A query filtering jobs by campaign must join
   `_private_jobs` to `_private_tasks`.
3. **A monitor that counts all-time `status='failed'` will report stale
   failures forever.** Scope every run-health query by `started_at >` the run
   start.
4. **`campaign:reconcile` used to finalise between discovery batches**, marking
   a campaign `completed_low_yield` at 115 of 1,000 while work continued. Fixed
   by gating finalisation on an empty discovery queue. The pipeline was fine;
   only the status lied — which is worse than a crash, because it looks like an
   answer.
5. **A watchdog that trusts a single field is not a watchdog.** The byte drift
   guard exited on that false completion and left two batches unmonitored. It
   now requires status *and* an empty discovery queue, and replays completed
   batches on restart so a crash leaves no hole in the record.
6. **`setsid` does not exist on macOS.** Background helpers must be started
   through the harness, not `setsid nohup`.
7. **Compose only substitutes variables it references.** Setting
   `METER_BLOCK_GSTATIC=false` on the shell did nothing until the key was added
   to `docker-compose.yml`; the container kept the code default and produced a
   symptom identical to a real finding.

---

## 11. Judgement notes

The standing rule on this project is **two independent measurements that agree
before acting on a diagnosis**, and when a tool reports total failure, check the
tool before believing it. It has paid for itself repeatedly, and the times it
was skipped are the times something had to be retracted.

Wrong root-cause calls, corrected only because a second measurement disagreed:
"PTR forward-confirmed", "Verifalia egress problem" (HTTP 402), "Google penalty
box", a nearly-published "Hostinger blocked port 25" resting on a probe script
that mis-scored every attempt — and, this phase, **"blocking www.gstatic.com
breaks discovery"**, which was quota exhaustion wearing a costume.

Things that dissolved on contact with data rather than being fixed:
`decodo-proxy` (built to solve an auth problem gosom had already solved
internally), `gbp_owner` (0/100 person-shaped), the crawl "coverage bug" (the
title gate was the wall), "57/75 on Long Island" (a measurement artefact of my
own making — 75/75 was the truth).

And the pattern worth carrying beyond this project: **the benchmark niche
contaminated three phases of conclusions.** Med spas were chosen first and are
close to the worst case for owner mailboxes; every inference drawn from them
about *the pipeline* was wrong in the same direction. The fix was cheap once
identified — one crawl census predicts Tier A across niches (2→1, 12→5, 13→9) —
and it is now a product feature (§2, `preflight_runs`). Measure the population
before concluding anything about the machine.

---

## 12. Commit history (this phase)

| Commit | What |
|---|---|
| `c3c0cf5` | Phase 3: registry + SERP naming, clinical-lead classes, freemail Tier B |
| `418d01a` | Phase 4a: reverse registry works, pattern discovery does not |
| `b2b1690` | Revert ladder extras, statewide reverse fallback, feedback stub |
| `9ef8531` | Niche validation tooling; fix mailto `%20`; enable statewide fallback |
| `20af04b` | maps: scale the discovery wait to the query count |
| `ee42403` | Niche validation: the constraint is the niche, and the predictor holds |
| `d8ec536` | Scale: national expansion, batched discovery, stale-lock recovery, SERP flag |
| `fe791d5` | Preflight census as a product feature; fix stall detection's blind spot |
| `dedc6e4` | proxy-meter: measure, block and budget Maps residential bytes |
| `a9b764a` | Maps bytes: block third-party hosts, stop duplicate email crawl |
| `2962115` | docs: log the deferred byte optimisations as follow-ups |
| `b0c8e9b` | scripts: per-batch byte drift guard |
| `05c8c8e` | reconcile: do not finalise while discovery is still batching |
| `2830709` | Fix payload lookup; make the drift guard survive a false completion |
