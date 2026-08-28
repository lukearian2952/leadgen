# LeadGen v2 — Handoff

State as of **2026-08-27**. Written so someone else (or me, later) can pick this
up without re-deriving anything. `ARCHITECTURE.md` is the design, `RUNBOOK.md`
is what to do when something breaks, `DECISIONS.md` is why things are the way
they are, `docs/REPORTS/` holds the measurements. **This file is what is
actually true right now.**

**One-line status:** the pipeline is built, measured, and proven at scale on two
niches. Registry coverage is five states with **NY and FL loaded whole**.
Verification is unblocked. The engineering is not the constraint and has not
been for some time — **coverage of the naming sources is**, and §5 says exactly
where the next percentage point is.

**The SERP experiment has run (§9). LinkedIn should not be built.** Founder
phrasing took the SaaS cohort from 0 candidates in 93 to 15, inside the 15–20%
band §9 set as the do-not-build threshold. The remaining SERP ceiling is
infrastructural rather than linguistic — see §9.

**Next action:** a FL ZIP→county table and a `registry_entities.county` backfill
for Florida. FL whole-state delivered its forward matches and **none** of the
reverse direction, which was 28% of NY's — §5.1.

---

## 1. What the pipeline does

```
maps:discover ──┐
                ├─▶ crawl:site ─▶ registry:match ─▶ [serp:owner] ─▶ enrich:lead
saas:discover ──┘   (name+email)   (name, both        (name, only     (mailbox,
                                    directions)        when it helps)  verify, tier)
                                                                            │
                                                  campaign:reconcile ◀──────┘
```

Discovery splits on the niche. `maps:discover` for brick-and-mortar — batched
and sequential, `MAPS_MAX_QUERIES` (36) per job, each enqueuing its successor,
because gosom falls over past a few dozen concurrent Maps searches.
`saas:discover` for online niches, which have no storefront: five buying-intent
SERP queries × three category-word variants, deduplicated to vendor domains.

`start_campaign_v2` picks between them from the niche.

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

Its crontab also carries the owner's `health-check.sh` and `maintenance.sh
backup` **duplicated three times each** — so three concurrent backups fire at
02:00. Reported, deliberately not edited: not ours.

### Containers (13 running)

| Service | Port | mem | Notes |
|---|---|---|---|
| **registry-db** | 127.0.0.1:5433 | 2g | Postgres 17, the state registries. §2 |
| verify-svc | :8080 | 256m | `network_mode: host`, required to bind `VERIFY_IPS`. **Firewalled** — §3 |
| proxy-meter | 127.0.0.1:8090 | 256m | Counts, blocks and budgets all Maps residential traffic |
| searxng | 127.0.0.1:8888 | 512m | JSON API. **Egresses through Decodo** — §7.3 |
| crawl4ai | 127.0.0.1:11235 | 2g | up; **still no job calls it** — the crawl fetches directly |
| maps-scraper | 127.0.0.1:8085 | 512m | gosom; egresses through proxy-meter |
| maps-worker | 127.0.0.1:9101 | 512m | `maps:discover`, `saas:discover` |
| crawl-worker | (scaled) | 512m | |
| registry-worker | 127.0.0.1:9105 | 512m | `registry:match`, `:ingest`, `:refresh` |
| serp-worker | 127.0.0.1:9102 | 512m | |
| enrich-worker | 127.0.0.1:9106 | 512m | |
| verify-worker | 127.0.0.1:9107 | 512m | Also serves `POST /feedback/mailbox` |
| scheduler | 127.0.0.1:9108 | 512m | `campaign:reconcile`, singleton — **never scale** |

`docker compose up -d` from `/opt/leadgen`. **Each worker builds its own image**,
so `docker compose build` (no service arg) is needed after a shared-code change
or older images silently keep running.

### Two databases

**Supabase** `paasggeawsoctfgqbqrd`, Postgres 17 — campaigns, leads, businesses,
contacts, the graphile queue, `job_runs`, alerts, `preflight_runs`.
**~25 MB** of the free plan's 500 MB.

**registry-db** — local Postgres container holding `registry_entities`,
`zip_county`, `county_for_zip` and `registry_ingest_runs`.
**9,930 MB · 12,606,482 entities** after Florida was loaded whole. Bounded by
`REGISTRY_MAX_DB_MB` (20 GB) rather than by a plan.

The registry moved out on 2026-08-27 because it was 239 MB of a 276 MB Supabase
database and is the only table that grows without bound, while being entirely
internal — no RLS policy references it, no Realtime subscription watches it, the
frontend has never read it. The move reclaimed **252 MB**.

**There is no cross-database join, and there never was one.** `registry:match`
reads a lead from Supabase, asks registry-db about it, writes the verdict back:
three statements before the split and three after. `leads.registry_entity_id` is
no longer a foreign key — it is provenance pointing into another database and
may outlive the row it names.

**Anything issuing one statement over `leads` *and* `county_for_zip` will
fail.** `scripts/_db.ts` has both pools and the reasoning.
`statewide-delta.ts` and `registry-dryrun.ts` are guarded to fail loudly rather
than return an empty result.

**Backups:** nightly `pg_dump --format=custom` at 03:20 UTC to
`/opt/leadgen/backups`, seven kept, ~33 MB each. Restore-tested 2026-08-27 —
all rows, all seven indexes, and a live trigram match against the restored copy.
`infra/registry-db/{backup,restore-test}.sh`.

Migrations applied through **`20260827000002_registry_moves_out`**.

### Connection budget — this is a hard ceiling
Supavisor allows ~15 session-mode clients project-wide; graphile-worker needs
session mode for `LISTEN/NOTIFY`. Each worker is capped at `maxPoolSize: 2`.
**Seven workers ≈ 14 slots is the ceiling.** An eighth crash-loops on
`EMAXCONNSESSION`, and so does an ad-hoc `psql`-style client while seven are up.

registry-db does **not** consume this budget — it is a local Postgres with its
own pool.

**Consequence for scripts:** use `DATABASE_URL` (transaction pooler, :6543), and
enqueue jobs with `graphile_worker.add_job` in SQL rather than `makeWorkerUtils`.

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
script at `infra/leadgen-firewall.sh`, idempotent. Verified active.

**Every other LeadGen port is `127.0.0.1:port`, registry-db included. Any new
service must follow that pattern or get a rule.**

Testing note: `nc` from outside reports 8080 as "connected". Hostinger's edge
terminates inbound TCP — a port with nothing listening *times out* rather than
refusing. Only "does application data flow" is a valid test from off-box.

`searxng/settings.yml` contains the Decodo password and is gitignored; the
tracked file is `settings.template.yml`, rendered by
`infra/render-searxng-settings.sh`.

---

## 4. Environment

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
| `MAPS_DEPTH` | 5 in compose, **run at 10** | every accepted byte figure was measured at depth 10 — §7.2 |
| `MAPS_WAIT_MINUTES` | derived: 30 s/query, 20–45 min | a fixed cap killed two good scrapes |
| `MAPS_SCRAPER_EMAIL` | `false` | gosom re-crawled every business site through residential |
| `METER_BLOCKING` | `true` | blocks tiles, fonts, photos, analytics, site-builder CDNs |
| `METER_BLOCK_GSTATIC` | `false` | **unresolved** — §7.1 |
| `METER_BUDGET_BYTES` | 0 (unlimited) | set per run; 2.5 GB was used for the 1,000 |
| `PATTERN_LADDER_EXTRAS` | `false` | measured as zero recovery for 2.6× the verification spend |
| `REGISTRY_REVERSE_STATEWIDE` | `true` | +1 per ~100 niche-scoped; **far more whole-state** — §5.1 |
| `REGISTRY_MAX_DB_MB` | 20000 | registry-db's own size; a good-neighbour limit, not a plan limit |
| `STALE_LOCK_MINUTES` | 60 (floor 50) | must exceed the longest job |
| `VERIFIER` | `verifalia` | port 25 is blocked upstream — §8.1 |

### Still not set
- **`SOCRATA_APP_TOKEN` is empty.** Every registry ingest has run on the shared
  anonymous pool: it completes, but slower and with retry backoff. Free from
  `evergreen.data.socrata.com/signup`. NY whole-state took 31 minutes on it.
- `LINKEDIN_ACCOUNTS` — see §9.

### Credential hygiene (outstanding)
`SUPABASE_ACCESS_TOKEN` was pasted into a chat transcript and **should be
rotated**. v1 keys in a pre-`git init` `.env`: `APIFY_API_KEY` should be revoked;
`OPENAI_API_KEY`, `GEONIX_API_KEY`, `TELEGRAM_*`, `VPS_SCRAPER_*`,
`GOOGLE_CSE_*` are read by no code and should be revoked rather than rotated.

---

## 5. Registry coverage — where the yield is

Five states. **NY and FL are loaded whole; the other three are niche-scoped.**

| State | Rows | Scope | Source |
|---|---|---|---|
| **FL** | 11,031,417 | **whole state** | Sunbiz SFTP, 1.8 GB quarterly archive |
| **NY** | 1,532,811 | **whole state** | `data.ny.gov` Socrata |
| CO | 30,259 | car-wrap tokens | `data.colorado.gov` Socrata |
| OR | 7,045 | car-wrap tokens | `data.oregon.gov` Socrata |
| CT | 4,950 | car-wrap tokens | `data.ct.gov` ×3, joined |

`registry:refresh` runs Sunday 03:00 UTC from the worker crontab, reading each
state's scope out of `registry_ingest_runs` — including the `whole_state` flag,
without which an empty scope is indistinguishable from a lost one and NY would
silently stop being refreshed.

**The Socrata route is exhausted**: a network-wide catalog search returns exactly
these four Socrata registries with person names. MA, NC, AK and OH are all
blocked for non-engineering reasons (no bulk product, paid-only, or a bot wall);
CA and IL are paid-only and together are 126 businesses of the car-wrap run.
`DECISIONS.md` has the full survey.

### 5.1 What whole-state bought, and a retraction

**Retracted:** "the reverse lookup contributed 1 of 51 … worth keeping, not
worth expanding."

That was measured on niche-scoped slices and was an artefact of the scoping, not
a property of the reverse direction. Reverse lookup asks whether a person found
on a website is an officer of *any* nearby entity; a slice holding only
wrap-named companies cannot answer it.

| | niche-scoped, 5 states, 1,042 leads | NY whole-state, 586 leads | FL whole-state, 71 leads |
|---|---|---|---|
| forward | 69 | 128 | 45 |
| **reverse (county)** | **1** | **42** | **0** |
| **reverse (statewide)** | **0** | **8** | **0** |

The reverse direction is **28% of all matches** once a state is loaded whole.
Whole-state coverage changes *what the pipeline can do*, not just how much it
finds.

### 5.1a Florida gets the forward half only — and this is the top follow-up

FL whole-state contributed **0 reverse matches, and structurally could not**.
`zip_county` holds only **NY and OR**, and all 11,031,417 Florida entities have
`county = ''` — Sunbiz carries city and ZIP, not county, and nothing backfills
it. The reverse direction keys on county, so it has no input.

Florida therefore bought the forward 72% of what NY's whole-state load bought,
and none of the remaining 28%. **A FL ZIP→county table plus a backfill of
`registry_entities.county` is the highest-value registry work available**: the
11M rows are already loaded and 99.8% of them carry a ZIP, so it is a join, not
another ingest.

### 5.2 Multipliers, for estimating what another state is worth

| Basis | Sendable per new name |
|---|---|
| Whole-state slice | **0.3** |
| Niche-scoped slice | **0.4** |

Measured: NY whole-state over 586 leads forecast +54 names, 44 materialised, 14
converted (0.32 per actual name, 0.26 per forecast). The 0.41 measured earlier
came from niche-scoped slices. A whole-state slice finds the marginal matches
and those convert worse — they sit on businesses whose domains are more often
catch-all or absent.

**Confirmed on Florida.** 71 FL leads, 14 forecast names, 14 materialised, 4
converted — **0.29 per name, against the 0.3 whole-state multiplier.**

**`registry-coverage-delta.ts` over-predicts naming by ~18% — on NY.** It asks whether a
registry officer would be *found*; the real stage then applies
`applyNameDecision`'s name-class and corroboration rules, which reject some. It
is an upper bound, not a forecast. Say so wherever its output is quoted.

### 5.3 The cheapest large improvement available

**Load the remaining three states whole.** NY took 31 minutes and 930 MB;
**FL took 125 minutes and 8.8 GB** and is by far the largest — CO, OR and CT are
all far smaller than either. `registry-enqueue.ts <STATE> --whole [mode]` is now
the supported path; NY and FL were the last two done by hand.

Note the ceiling is closer than it was: registry-db is at **9,930 MB of 20,000**
after Florida. The three remaining states are small, but a third whole-state
load the size of FL would not fit.

---

## 6. Measured runs

### Car wrap / United States — 1,042 businesses
Campaign `67aaaad4-c23a-44fc-9e94-e059e7470e00`.

| | n | % |
|---|---|---|
| discovered | 1,042 | |
| named | 244 | 23.4% |
| Tier A | 77 | 7.4% |
| Tier B | 67 | 6.4% |
| **sendable** | **144** | **13.8%** |

1.75 h wall clock, **$6.88 + 478¢ verification**, zero failed jobs, zero
dead-letters. 1.47 MB residential per business.

### Practice management SaaS / United States — 149 businesses
Campaign `0880d44f-400c-4132-91ac-9c142a448390`.

| | n | % |
|---|---|---|
| discovered | 149 | target was 100; the overshoot was a bug, now fixed |
| named | 56 | 37.6% |
| Tier A | 15 | 10.1% |
| Tier B | 20 | 13.4% |
| **sendable** | **35** | **23.5%** |

**0.69¢ per business, 0.05 MB residential each — ~30× cheaper than a Maps
campaign**, and the higher-yielding niche end to end.

**After the SERP experiment (§9): 74 named, 23 Tier A, 23 Tier B, 46 sendable —
30.9%.** The 93 leads that finished unnamed were replayed as campaign
`1d8b278e` and contributed 18 names and 11 sendable.

Named by source: `site_crawl` 50, `serp` 6, **`registry` 0** — a SaaS company
found by search has no postal address, so `registry:match` has no input. The
registry gains in §5 do not transfer to online niches.

### NY across all campaigns — 586 leads, 8 campaigns
After NY whole-state: named 237 → **281**, sendable 61 → **75**.

---

## 7. Open follow-ups

### 7.1 `www.gstatic.com` — unresolved, the largest byte lever left
37 MB of the 154 MB a 95-business batch spent — 24% of remaining cost.

**An earlier claim that blocking it returns zero businesses is retracted.** It
rested on a single run that coincided with Decodo's traffic limit being
exhausted. To settle it: **two runs with the flag on, two with it off, on a live
upstream, comparing row yield and not only bytes.**

### 7.2 Scroll depth 10 → 5 — never measured
`MAPS_DEPTH` defaults to 5 in compose but **every byte figure was taken at depth
10**. Depth cuts rows and bytes together, so it is not obviously a win on the
ratio. **Until measured, run at depth 10.**

### 7.3 SERP residential bytes are unmetered
SearXNG proxies internally, so its residential usage never passes through
`ProxyPool` and is not counted. The 2.5 GB per-campaign budget is enforced
against an undercount. Small today (~15 queries per campaign); the honest fix is
a meter in front of SearXNG like `proxy-meter` in front of gosom.

### 7.4 The preflight ships as a census, not a predictor
**Run for the first time 2026-08-27.** There was no `preflight:*` job and never
had been — a predictor with 13 passing tests, a table and two UI panels, with no
path from a niche to a number. `scripts/preflight-census.ts` is now that path
and `preflight_runs` holds five real rows.

**It fails its own launch test.** Across five niches it returned the *same* band
for every one:

| niche | census | predicted | actual Tier A |
|---|---|---|---|
| med spa / Long Island | 12.0% | 6.3–9% | 1.3% |
| dental / Long Island | 26.6% | 6.3–9% | 6.3% |
| vehicle wrap / NY | 19.0% | 6.3–9% | 9.0% |
| car wrap / US | 19.5% | 6.3–9% | 7.4% |
| practice mgmt SaaS / US | 38.9% | 6.3–9% | 10.1% |

3 of 5 "in band" means nothing when the band never varies.

**`SEED_CALIBRATION` cannot be reproduced.** Its three points (2.667 / 15.19 /
13.0, i.e. counts of 2 / 12 / 13) do not match any reading of the current data —
two independent attempts gave 9/21/19 (on-domain non-role, which is what
`crawl-site` stores) and 6/15/11 (on-domain and the local part matches a person
named on the site). **No code produces the seed values**; they were computed by
hand or by a script that is gone. `POOR_MAX = 5` and `MODERATE_MAX = 10` were
set for that vanished scale, so every reproducible census lands above 10 and
everything is "good".

The census also does not track Tier A monotonically on n=5 (26.6% yields less
than 19.0%), so there is not yet a relationship to calibrate *to*.

**Shipped:** the census number, on both UI panels, worded as a comparison
between niches. **Dropped:** the band, everywhere. Revisit when five to ten more
campaigns have gone through `scripts/preflight-census.ts`, then set thresholds
from those points and delete `SEED_CALIBRATION`.

### 7.5 Smaller, still open
- **Dead-letter requeue in the UI** — the architecture promises it; there is no
  button. `dead_letter` is currently empty.
- **The alert banner has never been seen with a live alert.** It builds and is
  wired. Verifalia's 402s would have been the cheapest possible test.
- **Playwright** — the brief names it; it needs a browser download and network.
- **`%SIGN%` matches `DESIGN`**, inflating every niche-scoped slice with design
  firms. Costs storage, not precision (the trigram floor still applies). Worth a
  word-boundary option before the next large niche-scoped ingest.

---

## 8. Known external blockers

### 8.1 Port 25 dropped upstream
Root cause established by three independent methods. Port-specific, not
host-specific; provider-independent; both address families. Hostinger agrees it
is an upstream IP-specific egress filter. Evidence in
`docs/hostinger-evidence.txt`.

**Consequence:** `VERIFIER=verifalia`, with **no working fallback**. verify-svc
cannot cover a Verifalia outage until this changes. Revert to `hybrid` when
unblocked.

### 8.2 Verifalia credits
Was exhausted 2026-08-26 and withheld the Tier A/B figure from two reports.
Topped up 2026-08-27 (2,503 credits); both campaigns re-verified, zero rows left
unverified.

**The lesson stands even though the block is gone:** `email_status = 'unknown'`
is the *absence of a verdict*, not a statement about a mailbox, and at a glance
it is indistinguishable from a genuine "cannot reach". **Check the credit
balance before concluding anything about a niche's deliverability.**

### 8.3 Decodo traffic limit
Exhausted once mid-phase, which invalidated a measurement and cost several
hours. The failure is a `407` with `x-error-message: … reached your current
traffic limit`. **A direct CONNECT test distinguishes it from anything in our
stack in one command** — do that first when discovery returns zero bytes.

### 8.4 The v1 pipeline is still deployed
Eight v1 Edge Functions remain ACTIVE. They drive Google Places API + Apify into
the same `leads` table. Until 2026-08-27 the UI's Start button called them.

`campaign-export` **is still the export path and must not be deleted.** The
others are one bookmark away from starting a v1 run. And **v1's pg_cron watchdog
must stay unscheduled** — `select count(*) from cron.job` must be 0; verify
before every run.

---

## 9. The SERP query experiment — run, and the LinkedIn decision

**Run 2026-08-27. Verdict: do not build LinkedIn.** Full write-up in
`docs/REPORTS/2026-08-27-serp-phrasing-and-florida.md`.

### The baseline was misquoted, and the correction matters

This section used to give the baseline as **6 candidates per 100 runs**. That is
right for the stage and wrong for the cohort: `serp:owner` ran on 100 leads,
which were exactly the 93 that finished unnamed plus 7 that other sources had
already named — and **all 6 candidates came from those 7**. Over the 93 the old
phrasing scored **0**.

### Three causes, where the design assumed one

| | what was assumed | what was measured |
|---|---|---|
| queries | brick-and-mortar phrasing | true |
| prompt | not considered | **the dominant cause** — `serpOwnerPrompt` requires a result to be "about this exact business at this location", and a SaaS vendor has no location. 85 model calls returned **4 people in total** |
| crawl | "only fetches 3 pages; `/about` and `/team` are the fix" | **describes v1.** Both paths were already in `FALLBACK_PATHS`, `PAGE_CAP` is 6, and the 93 averaged 3.44 pages. The real gap was `/company` and `/leadership` |

### The result

`founderQueries` + `serpFounderPrompt` for online niches, `/company` and
`/leadership` added to the crawl. Replayed into campaign `1d8b278e` — a fresh
campaign, because `PgBudgetLedger` is per campaign and the baseline had to
survive.

| | old phrasing | founder phrasing |
|---|---|---|
| runs | 93 | 93 |
| avg results per lead | 11.3 | 20.5 |
| **runs with an owner-grade candidate** | **0** | **15 (16.1%)** |

Cohort outcome, all net new: **18 named (19.4%), 8 Tier A, 3 Tier B, 11
sendable.** Practice-management SaaS overall **35 → 46 sendable, 23.5% → 30.9%.**

128¢ across both runs against a 300¢ cap. **The cap was never the constraint —
naming is the bottleneck, not verification.**

### The first result was a measurement of the infrastructure, not the phrasing

The run initially scored 1 in 89, and that number is void. `site:linkedin.com/in`
is honoured by exactly one upstream:

| engine | results | with a `linkedin.com/in` URL |
|---|---|---|
| bing | 2,040 | 3 (0.15%) |
| google cse | 89 | 17 (19%) |

**Bing silently discards the `site:` operator** and returns the company's own
domain. Google CSE answers **~9 queries and is then suspended for ~2 minutes**;
`serp:owner` fired 267 queries in four minutes, so Bing answered 96% of the run.
The 16.1% above was measured after re-pacing to one lead every 50 seconds.

This is the failure mode `searxng/settings.yml` already documents and §11 lists
as having caused a retraction before: the instance answers `200` with a
`results` array, just a much worse one. **Any SERP number taken from a burst run
is suspect — check the engine mix before believing it.**

### Why not LinkedIn

§9's own table: SERP at 15–20% means do not build it. 16.1% is inside the band.
Beyond that:

- The 93 leads the upside was sized against are now 75 — 18 are named.
- Everything already against it holds: `LINKEDIN_ACCOUNTS` empty, StaffSpy
  unmaintained, `tomquirk/linkedin-api` 404, and an eighth worker does not fit
  the ~15-slot session budget.

**Do this instead.** The SERP ceiling is now infrastructural, not linguistic:
one upstream honours `site:` and it sustains ~3.6 queries a minute. A paid
search API for the LinkedIn query alone — one query per lead — removes the
pacing constraint and is a config change, not a worker. `SOCRATA_APP_TOKEN` is
still empty too, and both are the same shape of fix: stop running the pipeline's
search layer on anonymous shared quota.

## 10. Operational traps — each of these cost real time

1. **Never restart a worker while `maps:discover` is in flight.** graphile holds
   the lock and its expiry is **4 hours**. `releaseStaleLocks` mitigates it, but
   a restart still abandons a running scrape and the bytes are already spent.
2. **`graphile_worker.jobs` does not expose `payload`** — it is on
   `_private_jobs`. A query filtering jobs by campaign must join
   `_private_jobs` to `_private_tasks`.
3. **A monitor that counts all-time `status='failed'` reports stale failures
   forever.** Scope every run-health query by `started_at >` the run start.
4. **`campaign:reconcile` used to finalise between discovery batches**, marking
   a campaign `completed_low_yield` at 115 of 1,000 while work continued. Fixed
   by gating finalisation on an empty discovery queue. Only the status lied —
   which is worse than a crash, because it looks like an answer.
5. **A watchdog that trusts a single field is not a watchdog.**
6. **`setsid` does not exist on macOS.** Background helpers must be started
   through the harness.
7. **Compose only substitutes variables it references.** Setting a flag in the
   shell does nothing until the key is added to `docker-compose.yml`; the
   container keeps the code default and produces a symptom identical to a real
   finding.
8. **The worker Docker build typechecks `test/`.** `frontend-tiers.test.ts`
   imports the React app, which is never deployed to the VPS, so it is excluded
   in `workers/tsconfig.json`. If a build fails on a missing `../../src/...`,
   that exclusion did not reach the server.
9. **Scripts run via `run.sh` write as uid 10001.** Output paths must be in a
   world-writable mount or they fail `EACCES` after doing all the work.
10. **`buildTaskList` must construct only the role's stages.** It used to build
    every task and filter afterwards, and `makeRegistryIngestTask` resolves the
    registry pool at construction — so after the registry split, six of seven
    workers crash-looped on `REGISTRY_DATABASE_URL is not configured` on the
    first restart, having never registered a task. Only `registry-worker` gets
    that variable in compose. Fixed 2026-08-27; the shape of the bug is worth
    remembering, because **nothing had restarted between the split and the fix,
    so a deployed system sat for a day in a state where any restart took down
    six of seven workers.**
11. **A SERP result taken from a burst run is not a measurement.** Google CSE is
    the only upstream honouring `site:`, and it answers ~9 queries before a ~2
    minute suspension; Bing answers anyway, discarding the operator. Check the
    engine mix in `serp_cache` before drawing a conclusion — §9.

---

## 11. Judgement notes

The standing rule is **two independent measurements that agree before acting on
a diagnosis**, and when a tool reports total failure, check the tool before
believing it. It has paid for itself repeatedly, and the times it was skipped
are the times something had to be retracted.

**Retracted after a second measurement disagreed:** "PTR forward-confirmed";
"Verifalia egress problem" (it was HTTP 402); "Google penalty box"; a
nearly-published "Hostinger blocked port 25" resting on a probe that mis-scored
every attempt; "blocking www.gstatic.com breaks discovery" (quota exhaustion
wearing a costume); and **"the reverse lookup is not worth expanding"** (§5.1),
which was niche scoping, not the reverse direction.

**Retracted in this phase:** "the SERP baseline is 6 per 100" (right for the
stage, zero for the cohort); "`crawl:site` only fetches three pages and needs
`/about` and `/team`" (that was v1 — both were already there); and the SERP
experiment's own first result of 1-in-89, which was Google CSE being
rate-limited rather than the phrasing failing. The last of these is the third
time a quota exhaustion has worn the costume of a real finding.

**Dissolved on contact with data rather than being fixed:** `decodo-proxy`,
`gbp_owner` (0/100 person-shaped), the crawl "coverage bug" (the title gate was
the wall), "57/75 on Long Island" (a measurement artefact of my own making).

**Three patterns worth carrying beyond this project:**

**The benchmark niche contaminated three phases of conclusions.** Med spas were
chosen first and are close to the worst case for owner mailboxes; every
inference drawn from them about *the pipeline* was wrong in the same direction.
Measure the population before concluding anything about the machine.

**A test proving code handles an input correctly says nothing about whether that
input ever arrives.** `registry:refresh` had a passing test for carrying FL's
quarterly mode forward. The ingest never wrote the field. Florida would have
been silently re-ingested as five days of filings instead of the whole state.

**Built, tested, and never executed is its own failure mode, and it has happened
four times here.** Florida's date format (parsed backwards, test asserted only
the *shape*), the preflight census (a predictor with no runner), the
`status = 'ok'` checks written against a schema that says `complete`, and now
`buildTaskList` after the registry split — tested, deployed, and broken in a way
only a restart could reveal. Run the thing once against reality before believing
any of it.

---

## 12. Commit history (this phase)

| Commit | What |
|---|---|
| `69ed85b` | Registry: OR and CT adapters, and a disk ceiling for ingest |
| `f6981be` | Registry: fix Florida's date format, measure the coverage gain |
| `95e53dd` | Registry: weekly refresh from the worker's own crontab |
| `6e97f6a` | searxng: proxy the engine requests — four of five were captcha'd |
| `aacd7a8` | SaaS discovery: search-based, because all four directories are closed |
| `8744e2d` | Phase 5: point the UI at v2, show tiers, write the runbook |
| `4d053d4` | Verification unblocked: the two withheld Tier A/B figures |
| `853e969` | Registry moves out of Supabase into its own local Postgres |
| `a6af2f1` | registry-db: nightly dump, seven kept, restore actually tested |
| `a3b016b` | preflight: give the census a runner, and report what it says |
| `d5f68f1` | NY whole-state, and the preflight launch test says not yet |
| `5ffb5c1` | ui: show the census, drop the band it cannot yet support |
| `71ae092` | docs: rewrite HANDOFF as the current-state document |
| *(this)* | SERP founder phrasing, FL whole-state, and the boot break a restart found |
