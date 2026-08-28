# LeadGen v2 — Handoff

State as of **2026-08-28**. Written so someone else (or me, later) can pick this
up without re-deriving anything.

| document | answers |
|---|---|
| **HANDOFF.md** (this) | what is true right now, and why |
| **OPERATIONS.md** | **how to run it** — start here if you are operating, not building |
| `RUNBOOK.md` | it broke, what now |
| `ARCHITECTURE.md` | the design |
| `DECISIONS.md` | why things are the way they are |
| `REPORTS/final-build-report.md` | what it yields, what that cost, which levers moved it |
| `REPORTS/weekly/` | what changed each week |

**The build phase is closed** — see §13.6. What remains is operation, niche
selection, and calibration.

**One-line status:** the pipeline is built, measured, and proven at scale on two
niches. Registry coverage is five states with **NY and FL loaded whole**.
Verification is unblocked. The engineering is not the constraint and has not
been for some time — **coverage of the naming sources is**, and §5 says exactly
where the next percentage point is.

**The SERP experiment has run (§9). LinkedIn should not be built.** Founder
phrasing took the SaaS cohort from 0 candidates in 93 to 15, inside the 15–20%
band §9 set as the do-not-build threshold. The remaining SERP ceiling is
infrastructural rather than linguistic — see §9.

**FL reverse is now enabled and the yield delta was zero — §5.1a.** The census
ZIP→county crosswalk is loaded for all 56 states and Florida's leads resolve a
county, but reverse lookup runs only on people the *crawl* named, and the crawl
names a first+last on 5 of 71 FL leads. County was never the binding constraint;
crawl naming is.

**Next action:** none of the remaining registry work moves the number much —
§13 has the ceiling arithmetic and what is left that does.

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

`zip_county` now carries two kinds of row, distinguished by `source`:
**46,960 `census`** rows from the Census ZCTA→county crosswalk covering 56
states and territories, and 81,763 `registry` rows derived from filings.
`county_for_zip` prefers census. The derived rows were the only source before
and they are a filing address rather than a geography — they put 07306 (Jersey
City NJ) in Suffolk, 10996 (West Point, Orange County) in Saratoga and 27603
(Raleigh NC) in the Bronx. They are kept as the fallback for a ZIP the
crosswalk does not cover. `scripts/zip-county-load.ts` reloads it.

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
| `SERPER_API_KEY` | empty | empty selects SearXNG; setting it selects Serper — §9.1 |
| `SERP_PROVIDER` | empty | forces `searxng` or `serper`, for an A/B without a code change |
| `SEARXNG_MIN_QUERY_INTERVAL_MS` | 16700 | ~9 queries per 2 min is what Google CSE tolerates — §9 |
| `SERPER_MAX_QUERIES_PER_CAMPAIGN` | 500 | Serper has no rate ceiling of its own; this is the budget |
| `HUNTER_API_KEY` | set | provider mailbox lookup — §13.3 |
| `HUNTER_MAX_LOOKUPS_PER_CAMPAIGN` | 500 | paid lookups are capped per campaign like verification |

### Still not set, deliberately
- **`SOCRATA_APP_TOKEN` is accepted as permanently empty.** Every registry
  ingest has run on the shared anonymous pool and every one has completed, NY
  whole-state included (31 minutes, 4.27M rows). It is slower and it can 429
  into the adapter's retry backoff — a throughput fact, not a fault. **The boot
  and per-ingest warnings for it have been removed**: a warning nobody intends
  to act on trains people to ignore the log it prints in.
- **`LINKEDIN_ACCOUNTS` — and LinkedIn is not being built. §9.**
- `SERPER_API_KEY` — unset, so SERP runs on SearXNG at its measured pace. §9.1.
- **`GOOGLE_CSE_API_KEY` is set, dead, and unused.** Abandoned — §9.0.

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

### 5.1a Florida reverse: enabled, and worth nothing — the constraint was elsewhere

Florida contributed **0 reverse matches** after being loaded whole, and the
diagnosis at the time was that it structurally could not: `zip_county` held only
NY and OR, and all 11,031,417 FL entities have `county = ''` because Sunbiz
publishes city and ZIP but no county.

That diagnosis was half right, and acting on it is what showed which half.

**What was fixed.** The Census ZCTA→county crosswalk is loaded for all 56 states
(§2), so a Florida lead now resolves a county — **0 → 45 of 71 leads carry one**.
And `reverseLookup`'s entity-side filter gained a third branch that resolves an
entity's county from its ZIP when the registry omitted it. That second half is
not optional: the crosswalk alone would have made things *worse*, because leads
would start resolving to "Miami-Dade" while every Florida entity still failed
`county = any($2)`, taking reverse from wrongly-broad to exactly zero.

It costs nothing at query time. `officers @> …` is the driver and is served by
the GIN index — a specific first+last matches a handful of rows out of eleven
million — so the crosswalk is consulted for those few, not for the table.
Measured at **190 ms**. **A backfill of `registry_entities.county` is therefore
an optimisation, not a correctness fix**, and an expensive one: every row update
rewrites all seven indexes including two GIN, which measured at ~5,500 rows/min
against a 2 GB container and 512 MB of shared buffers — 30 hours for 10.4M rows.
`scripts/registry-county-backfill.ts` exists and works; roughly 400k FL rows are
done. There is no reason to finish it.

**The delta was zero.** FL stayed at 47 named and 20 sendable. The reason is not
county at all:

| | n |
|---|---|
| FL leads | 71 |
| crawled | 71 |
| with any name candidate | 47 |
| **with a `site_crawl` candidate carrying first *and* last** | **5** |
| people reverse actually looked up | 8 |
| reverse hits | 1 |

**Reverse lookup only runs on people the crawl named.** It asks "is this person
an officer of an entity near here", so a lead with no crawl-named person has
nothing to ask about. Five of seventy-one had one. That is the ceiling on the
reverse direction for this niche, and no amount of registry coverage moves it.

The one hit was *High Tide Graphics* in **Volusia** — a small county, which is
exactly where the county-scope assumption holds.

### 5.1b A precision bug Florida exposed, in every state

The reverse lookup's ambiguity guard applied only to the statewide fallback,
reasoning that "the county scope is what keeps a full-name match meaningful".
True of NY's counties. Not true of Miami-Dade, which returns **200+** entities
for `Maria Rodriguez` and 200+ for `Jose Garcia` — county-scoped, and no
narrower than statewide for a common name. The county path then took `rows[0]`
of an arbitrary three, with `limit 3` making "three" and "three hundred"
indistinguishable.

It had not yet produced a wrong name only because the dense-county leads had no
crawl-named people to look up. It would have at scale.

`STATEWIDE_MAX_ENTITIES` is now `MAX_SHARED_ENTITIES` and both scopes apply it.
Re-running every lead holding a reverse-derived candidate: **5 county candidates
rejected as too-common**, 29 hits from 69 people checked, and **sendable
unchanged at 224** — the rejected five were not the winning name on any lead. A
precision fix that cost no yield.

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

### 7.3 SERP is metered now — partially
`serp:owner` and `enrich:lead`'s address query both write a **`serp_queries`**
row to `source_costs`, stage `serp:<provider>`, carrying the live query count
(cached queries excluded), the response bytes and the per-query cost. Verified
live: `units 2, proxy_bytes 10736, serp:searxng`. Two rows per campaign on
purpose — `serp` counts *leads* and carries the model cost, `serp_queries`
counts *queries* and carries the transport, because one lead is three queries
and the paid-provider cap is a query budget.

**Still not counted:** SearXNG's own upstream requests, which egress through
Decodo without passing `ProxyPool`. What is metered is what the worker received.
The honest fix remains a meter in front of SearXNG like `proxy-meter` in front
of gosom.

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
  button. **`dead_letter` was never empty**, which this file claimed: three rows
  had sat there since 17 and 26 August. All three are now closed out with a
  written reason via the new `resolution` column
  (`20260828000001_dead_letter_resolution.sql`), and **0 are outstanding**. Two
  were the depth-5 Maps measurements killed by the old fixed 20-minute cap —
  which is the recorded reason §7.2 says "never measured" — and one was the FL
  quarterly date bug, since superseded by a successful whole-state ingest. A
  dead letter can now end as requeued, resolved-with-reason, or outstanding;
  before, everything looked outstanding forever.
- **The unverified-tier monitor now exists.** `campaign:reconcile` raises
  `tiered_rows_unverified` when a campaign finalises with leads in Tier A/B/C
  that no verifier ever ran on — counting both `verifalia_checks` and
  `verify_svc_checks`, and excluding `rejected`, which is rejected before
  verification by design. This is the bug that turned out to be worth more than
  the paid provider: 20 rows, 10 of them sendable once actually verified. It
  reads zero across all campaigns as of 2026-08-28.
- **The alert banner has now been seen with a live alert.**
  `scripts/alert-402-drill.ts` drives the real `VerifaliaProvider` against a
  local stub answering 402 — everything downstream of the HTTP response is
  production code — and confirms the row is open, carries
  `verifalia_payment_required` / `error`, is returned by exactly the predicate
  `useAlerts` uses, and that `alerts` is in the `supabase_realtime` publication
  so the banner appears without a reload. `raise_alert` deduped a second firing
  into `occurrences: 2` rather than a second row. `--clear` acknowledges it and
  deletes the drill campaign.
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

### 9.0 Google CSE: abandoned

`GOOGLE_CSE_API_KEY` is set, does not work, and was never in the SERP path.
Both halves were checked and the conclusion is closed — **do not revisit this
without new information.**

The load-bearing fact, which is easy to rediscover the hard way: **SearXNG's
`google cse` engine is not the Custom Search JSON API.** Its own source declares
`use_official_api: False` and `require_api_key: False`, and it scrapes
`google.com/cse/cse.js` using a third-party CX hardcoded into SearXNG. Our
`settings.yml` sets no `api_key` and no `cx`, and that engine would ignore them
if it did.

**So the ~9-queries-then-suspend ceiling is Google throttling a scraper, not an
API quota, and no key or billing change can lift it.** `SEARXNG_MIN_QUERY_INTERVAL_MS`
stays at 16700 for that reason.

Reaching Google's paid API would mean enabling Custom Search JSON API on the
project and adding a provider that calls `googleapis.com/customsearch/v1` with
our own `cx` — a third provider beside SearXNG and Serper, not a setting.

**Serper is the only paid SERP option**, and it is inert without
`SERPER_API_KEY`: `makeSerpProvider` returns SearXNG when the key is absent, and
warns and falls back if `SERP_PROVIDER=serper` is set without one.

### 9.1 The SERP provider switch

The 16.1% was measured at one lead per 50 seconds. That pacing is now part of
the system rather than a property of the script that happened to run it:
`sources/serp-provider.ts` puts SearXNG and Serper behind one interface, and
`SerpSource` takes a provider rather than a URL.

| | SearXNG | Serper |
|---|---|---|
| selected when | `SERPER_API_KEY` empty | key present |
| pacing | 16.7 s between queries, process-wide | none |
| cost | free | ~0.1¢/query |
| cap | none (paced instead) | `SERPER_MAX_QUERIES_PER_CAMPAIGN`, default 500 |

The pacer chains on a shared promise rather than sleeping inside a job, because
`serp:owner` runs at `WORKER_CONCURRENCY` and five parallel sleeps produce five
times the intended rate. Only serp-worker registers the stage, so one process is
the whole fleet for this purpose.

The cap reads `source_costs` where `source = 'serp_queries'`, the same row the
meter writes, so the budget and the spend cannot disagree.

**Adding the key is the whole migration and removing it is the whole rollback.**
`SERP_PROVIDER` forces either one for an A/B on the same box.

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
    engine mix in `serp_cache` before drawing a conclusion — §9. The pacing is
    enforced in `serp-provider.ts` now, so this bites only if someone raises
    `SEARXNG_MIN_QUERY_INTERVAL_MS` or calls the source directly.
12. **An `update` whose predicate wraps the indexed column in a function does
    not use the index.** The FL county backfill compared
    `left(regexp_replace(postal_code,…),5) = $2` against an index on
    `(state, postal_code)` and sequentially scanned 11M rows 1,174 times — 44 s
    each, 14 hours. Plain equality on the 98.2% of codes that are already five
    characters, plus one mop-up pass, is minutes. `explain` the statement before
    launching anything that runs a thousand times.
13. **Row updates on `registry_entities` are expensive out of proportion to the
    column changed.** Seven indexes including two GIN, a 2 GB container and
    512 MB of shared buffers against a 9.9 GB table: ~5,500 rows/min regardless
    of how small the update is. Prefer resolving at query time over
    denormalising — §5.1a is the worked example.

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

## 13. The sendable ceiling, and whether the build phase is done

Measured on **1,395 unique businesses**, deduplicated by business across
campaigns (the SaaS experiment replayed 93 businesses that already existed, and
counting both would inflate every rate).

### 13.1 Where each niche actually loses

`sendable% = naming% × mailbox-conversion%`, and the two factors fail
independently:

| niche | businesses | named | **naming** | sendable | **mailbox conv** | **sendable%** |
|---|---|---|---|---|---|---|
| car wrap | 921 | 234 | 25.4% | 128 | 54.7% | **13.9%** |
| med spa | 174 | 99 | 56.9% | 17 | 17.2% | **9.8%** |
| practice mgmt SaaS | 149 | 74 | 49.7% | 46 | 62.2% | **30.9%** |
| vehicle wrap shop | 93 | 34 | 36.6% | 22 | 64.7% | **23.7%** |
| dental practice | 74 | 44 | 59.5% | 14 | 31.8% | **18.9%** |

**There are two different problems here and they need different work.**

*Naming-limited:* car wrap (25.4%) and vehicle wrap (36.6%) name a quarter to a
third of businesses and then convert well. *Mailbox-limited:* med spa (56.9%
named → 17.2% converted) and dental (59.5% → 31.8%) find the person and cannot
reach them. SaaS is the only niche that is good at both, which is why it is the
best-yielding one at 30.9%.

This retires "the benchmark niche contaminated three phases" as a live risk by
naming the mechanism: med spas are not a bad niche for *naming*, they are close
to worst-case for *mailboxes*, and they were the niche every early inference
about the pipeline was drawn from.

### 13.2 The dominant remaining loss has one cause

**176 businesses are named and unmailable** — 12.5% of everything processed.
Their failure mode is nearly uniform: **no `owner_email` was ever constructed
that verified.** Not "constructed and bounced" — of 209 Tier C rows, 205 have no
owner mailbox at all, 1 risky, 0 invalid. Only 34 are catch-all domains, and a
catch-all is not a blocker in itself: `enrich-lead` already promotes a
catch-all to Tier B when the address follows a known pattern on a domain that
reads its mail.

So this is not a verification problem and not a gate problem. **The pipeline
guesses mailboxes from patterns and has no source that simply knows one.**

**v2 has no provider lookup.** v1 had `provider.ts` (Hunter / Apollo);
`discoverDomainPattern` in v2 uses four free sources — crawl emails, GBP
emails, `mailto:`, stored contacts — plus one SERP query, then constructs
candidates from patterns. `PATTERN_LADDER_EXTRAS` was measured as **zero
recovery for 2.6× the verification spend**, which says the pattern ladder is
exhausted, not that the mailboxes do not exist.

### 13.3 The ceiling, measured — and the 35% assumption was wrong

§13.3 previously projected off an **assumed** 35% provider hit rate and said to
measure it before committing. It has been measured, and the projection was
optimistic in two independent ways.

**Hunter's hit rate is 24.3%, and most of it is guesswork.** Over the 189 Tier C
leads with a name and a domain, Hunter returned an address for 46. **Only 13 of
those 46 had `sources > 0`** — had actually been seen on a public page. The
other 33 were inferred from the domain's pattern, which is precisely what
`candidateLadder` already did before the lookup was bought.

**Verifying the 46 through our own gate:** 9 deliverable, 29 catch-all, 8
risky/invalid. Taken at face value that is 38 of 189 "sendable" — 20.1%, already
well below 35%.

**End-to-end it is far smaller than that.** Running the real pipeline over 60
Tier C leads produced 8 sendable, of which **the provider's address won twice**:

| | |
|---|---|
| `jamiefrew@carepatron.com` | `sources: 30`, not catch-all, **verified deliverable → Tier A**. A local part no ladder would ever generate |
| `sheila.brody@greenspany.com` | `sources: 0`, catch-all domain, risky → Tier B on the concession, not on evidence |

The other six were recovered by **re-running the stage at all** — see §13.7.

That one comparison is the whole component. The provider is worth having exactly
where the real mailbox does not follow a guessable pattern *and* it has been
observed; everywhere else it re-proposes what the ladder already tried.
`PROVIDER_MIN_SOURCES = 1` now admits only observed addresses, because an
inferred address on a catch-all domain manufactures a Tier B row that looks like
evidence and is a guess — the failure mode the 6.4% bounce rate taught.

**Revised ceiling.** ~24% hit × ~28% observed ≈ **7% of Tier C leads** gain an
address worth having, converting well when they do. Against 158 remaining Tier C
businesses that is roughly **+10, or +0.7 points globally** — not the +4 to +6
projected. Per niche the ordering is unchanged and every number is lower; the
niche differences in hit rate (med spa 31.9%, car wrap 22.1%, SaaS 26.1%, dental
12.5%, vehicle wrap 0/5) are on samples too small to plan against.

**Measured this session: 16.1% → 17.3% sendable** (224 → 242 of 1,395), and only
about a fifth of that gain is attributable to the provider.

### 13.4 What is left from the brief that moves the number

| item | worth | verdict |
|---|---|---|
| **Re-running never-verified rows** | **+0.7 pts, free** — 50% of that bucket converts | **Done.** §13.7. Highest return of anything measured |
| **Provider lookup (Hunter)** | **+0.7 pts globally, measured** — not the +4 to +6 projected | **Built.** Keep it gated on `sources > 0`; do not scale spend on it |
| SERP at speed (`SERPER_API_KEY`) | +3–5 pts on SaaS only | Cheap, and the hypothesis is testable — §13.5 |
| Playwright | ~13% of crawls fetch **zero** pages (180/1145 car wrap, 43/331 med spa). Some are dead sites, some are JS-only | Unmeasured. Worth one measurement, not a build |
| LinkedIn | +14–18 sendable on SaaS, before the founder phrasing took 18 of the 93 | **No.** §9 |
| More whole-state registries | 0.3 sendable per name, and **the Socrata route is exhausted** — CO/OR/CT are all that remain and they are small | Marginal |
| FL county backfill | **Zero.** §5.1a | No |
| Preflight predictor | Needs 5–10 more campaigns before thresholds mean anything | Blocked on data, not code |
| gstatic blocking, depth 10→5 | Bytes, not yield | Cost work, not ceiling work |
| Dead-letter requeue button | Operational | Small |

### 13.5 The SaaS SERP hypothesis, and why it is still open

The founder phrasing scored 16.1% **with Google CSE answering only ~26% of
results** even at 50-second pacing (584 CSE against 1,678 Bing across the paced
run). Bing discards `site:` entirely, so roughly three-quarters of that run
asked the LinkedIn question of an engine that ignored it.

That is not proof that full coverage yields more — the leads CSE did reach may
have been the easy ones — but it is a specific, cheap test: run the 75 still
unnamed SaaS businesses through Serper, where every query is a real Google
query, and compare against the 16.1%.

### 13.7 The Tier C bucket was contaminated, and clearing it beat the provider

Ten per cent of Tier C was never unmailable. **20 of 201 Tier C rows had
`verifalia_checks: 0`** — Verifalia never ran on them at all. Their
`email_status` was `unknown`, which §8.2 already warns is *the absence of a
verdict, not a statement about a mailbox*, and at a glance is indistinguishable
from "cannot reach". At population scale it had quietly become 10% of the
category the entire ceiling analysis was built on.

Re-running those 20: **10 became sendable — 8 Tier A, 2 Tier B.** A 50%
conversion rate, for no provider spend and no new capability.

That is a better return than the provider produced on the same population, and
it means **§13.2's "176 named and unmailable" was overstated**. The corrected
figure is 158 Tier C businesses, all of which now carry a real verdict; zero
remain unverified.

**The lesson generalises past this bucket.** Any figure derived by counting rows
in a terminal state is only as good as the guarantee that every row reached it
for the stated reason. `email_status = 'unknown'` had no such guarantee, and
nothing was watching for it — the watchdog re-queues `pending_verify`, which
these rows were not. Worth a monitor: **a Tier C row with zero verification
checks is a bug, not a result.**

### 13.6 Is the build phase done?

**Yes. Provider lookup was the last item and it is built, measured and shipped.**

Everything the brief describes as machinery is built, deployed, measured and has
survived a restart. The faults found across these phases were a latent boot
break, a query that could not use its index, a precision guard missing from one
of two paths, and a contaminated terminal state — maintenance, not missing
capability.

**The ceiling is lower than §13 first projected, and the reason is worth
keeping.** Provider lookup was sized at +4 to +6 points on an assumed 35% hit
rate. Measured: 24.3% return an address, 28% of those are observed rather than
inferred, and end-to-end it won twice in sixty. It is worth about **+0.7
points** — real, cheap, and roughly what re-running twenty mislabelled rows was
worth for free.

**What that says about where the yield now is.** Every remaining lever is a
purchase or a measurement, and the two largest things this session found were
both *hygiene*: rows that never got a verdict, and a guard missing from a path
nobody had exercised. The pipeline's yield is now bounded by the populations it
runs on — 25% of car-wrap businesses name anybody at all — not by anything left
unbuilt.

Recommendation: **close the build phase.** Run the census on five to ten more
campaigns so the preflight can finally be calibrated (§7.4), keep the provider
gated at `sources > 0`, and treat further yield work as niche selection rather
than engineering.

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
| `9141d9b` | SERP founder phrasing, FL whole-state, and the boot break a restart found |
| `019016e` | ZIP→county crosswalk, the SERP provider switch, and the ceiling arithmetic |
| `d113f13` | Provider lookup, and two measurements that were smaller than projected |
| *(this)* | Close the build phase: the monitor, the operator's manual, the weekly report |
