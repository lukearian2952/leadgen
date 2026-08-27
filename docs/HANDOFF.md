# LeadGen v2 — Handoff

State as of **2026-08-27**. Written so someone else (or me, later) can pick this
up without re-deriving anything. `ARCHITECTURE.md` is the design, `RUNBOOK.md`
is what to do when something breaks, `DECISIONS.md` is why things are the way
they are, `docs/REPORTS/` holds the measurements. **This file is what is
actually true right now.**

**One-line status:** the pipeline is built, measured, and proven at scale on two
niches. Registry coverage is five states with NY loaded whole. Verification is
unblocked. The engineering is not the constraint and has not been for some time
— **coverage of the naming sources is**, and §5 says exactly where the next
percentage point is.

**Next action, already designed and not yet run:** the SERP query experiment in
§9. It is the cheapest remaining lever on SaaS yield and it gates the decision
on whether to build LinkedIn at all.

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
**1,176 MB · 1,741,635 entities.** Bounded by `REGISTRY_MAX_DB_MB` (20 GB)
rather than by a plan.

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

Five states. **NY is loaded whole; the other four are niche-scoped.**

| State | Rows | Scope | Source |
|---|---|---|---|
| **NY** | 1,532,811 | **whole state** | `data.ny.gov` Socrata |
| FL | 166,570 | car-wrap tokens | Sunbiz SFTP, 1.8 GB quarterly archive |
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

| | niche-scoped, 5 states, 1,042 leads | NY whole-state, 586 leads |
|---|---|---|
| forward | 69 | 128 |
| **reverse (county)** | **1** | **42** |
| **reverse (statewide)** | **0** | **8** |

The reverse direction is **28% of all matches** once a state is loaded whole.
Whole-state coverage changes *what the pipeline can do*, not just how much it
finds.

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

**`registry-coverage-delta.ts` over-predicts naming by ~18%.** It asks whether a
registry officer would be *found*; the real stage then applies
`applyNameDecision`'s name-class and corroboration rules, which reject some. It
is an upper bound, not a forecast. Say so wherever its output is quoted.

### 5.3 The cheapest large improvement available

**Load the other four states whole.** NY took 31 minutes and 930 MB against a
20 GB ceiling; FL, CO, OR and CT are all smaller than NY. Before the registry
moved out of Supabase this was impossible; it is now routine.

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
campaign**, and the higher-yielding niche end to end (23.5% vs 13.8%).

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

## 9. Next step: the SERP query experiment

**Designed, not run.** This is the immediate next action and it gates the
LinkedIn decision.

### The question
SaaS naming leaves 93 of 149 leads unnamed, all of them with a website.
`registry:match` cannot help (§6 — no postal address). So the gap is
crawl + SERP, and SERP is the half that can be improved without new
infrastructure.

### What SERP currently does
`serp:owner` ran on 100 SaaS leads:

```
runs                  100
runs with a candidate    6      all owner_grade
haiku calls             92
```

`ownerQueries` in `src/sources/serp.ts` issues two queries:

```
"<business>" <town> owner OR founder
site:linkedin.com/in "<business>"
```

Both are **brick-and-mortar phrasings**. "owner" is not the word a SaaS company
uses, and a bare company name against `linkedin.com/in` matches employees rather
than founders.

### The change to test
For niches where `resolveNicheFilter(...).serp` is true (i.e. online/SaaS),
use founder-shaped queries instead:

```
"<company>" founder OR CEO OR "co-founder" site:linkedin.com/in
"<company>" "founded by" OR "our story"
site:<domain> about OR team OR leadership
```

The third is the important one: a SaaS vendor's `/about` and `/team` pages name
the founders, and `crawl:site` only fetches three pages, which are usually
`/`, `/pricing` and whatever it found first.

### How to measure it
Re-run `serp:owner` over the **same 93 unnamed leads** of campaign
`0880d44f-400c-4132-91ac-9c142a448390`. The 30-day `serp_cache` means the old
queries cost nothing to keep for comparison; the new ones are fresh.

Success is the candidate rate. Current baseline is **6 per 100**.

### The decision it gates

| Outcome | Then |
|---|---|
| SERP reaches **15–20%** | LinkedIn's remaining upside roughly halves. Do not build it |
| SERP stays near **6%** | LinkedIn is the only remaining lever on SaaS naming |

**Do not build LinkedIn before this runs.** Its upside — 93 unnamed leads, a
generous 50% hit rate, converting at 0.3–0.4 — is **+14 to +18 sendable**, taking
SaaS from 23.5% to ~33–35%. Real, but against it: `LINKEDIN_ACCOUNTS` is empty
and the accounts are yours to have banned; StaffSpy's last release is 2025-01-06
and `tomquirk/linkedin-api` is still 404, so vendoring means owning it; and
starting `linkedin-worker` makes eight workers against a ~15-slot session budget
(§2), so something must be scaled down first.

The SERP experiment costs a query change and one re-run.

---

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
three times here.** Florida's date format (parsed backwards, test asserted only
the *shape*), the preflight census (a predictor with no runner), and the
`status = 'ok'` checks written against a schema that says `complete`. Run the
thing once against reality before believing any of it.

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
