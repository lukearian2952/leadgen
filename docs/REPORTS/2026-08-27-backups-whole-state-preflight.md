# Backups, NY whole-state, and the preflight launch test

**Date:** 2026-08-27
**Covers:** items 1–4 of the standing queue.
**Status:** 1–3 done. **Item 3 says the preflight is not ready to ship**, with
numbers. Item 4: LinkedIn **not built** — the recommendation is a cheaper
experiment first, justified below.

---

## 1. registry-db backups

Nightly `pg_dump --format=custom` at **03:20 UTC**, seven kept, to
`/opt/leadgen/backups`.

| | |
|---|---|
| Dump size | **33 MB** (from a 241 MB database at the time) |
| Seven kept | ~231 MB steady state |
| Disk | 120 GB free |
| Restore-tested | **yes** — see below |

Timing is 03:20 because `registry:refresh` fires Sunday 03:00 and staggers its
states 20 minutes apart; a dump at 03:20 catches last week's settled data rather
than a half-refreshed one. `flock` prevents a long dump overlapping the next.

Three details that are the difference between a backup and a hypothesis:

* Dumps write to `.partial` and rename on success, so an interrupted dump never
  occupies a slot in the retention window — the failure that turns "seven
  backups" into "six and a corrupt file".
* The output is checked for pg_dump's `PGDMP` magic bytes before it counts,
  which catches pg_dump writing an error to stdout.
* `--no-owner --no-privileges`, because a restore target's roles will not match
  and without them every statement fails and a working backup looks broken.

### The restore test

`infra/registry-db/restore-test.sh` restores the newest dump into a throwaway
container on its own volume, then deletes both — on success, failure or Ctrl-C
alike.

```
restored     304,719 entities · 7,643 zips · 5 ingest runs
per state    FL 166,570 · NY 95,895 · CO 30,259 · OR 7,045 · CT 4,950
indexes      all 7, including name_trgm and officers_gin
trigram      HIGH GRAPHICS LLC | 1.000
```

The index check earns its place: a restore that brought the rows but not the
trigram index would report success and be unusably slow.

Retention verified by staging eight dated files and confirming the next run
pruned to seven, newest first.

**Noted, not touched:** the box's crontab contains the owner's two unrelated
jobs (`health-check.sh`, `maintenance.sh backup`) **duplicated three times
each**. `maintenance.sh backup` therefore runs three times concurrently at
02:00. That is their production cron, not ours, so it is reported rather than
edited.

---

## 2. NY whole-state

The niche scoping that caused the med-spa mismatch is gone for NY.

```
seen                4,273,719     the entire state
written             1,474,376     34.5% name a person
skipped anonymous   2,799,343     named nobody — cannot produce a name either direction
registry-db         242 MB → 1,176 MB
NY rows             95,895 → 1,532,811      16×
```

Completed in ~31 minutes at 10,000 rows a page. The 20 GB ceiling was never
approached.

### The delta over every NY lead

586 leads across **8 campaigns** — not just the car-wrap one.

| | before | after | Δ |
|---|---|---|---|
| named | 237 (40.4%) | **281 (47.9%)** | **+44** |
| Tier A | 19 | **22** | +3 |
| Tier B | 42 | **53** | +11 |
| **sendable (A+B)** | **61 (10.4%)** | **75 (12.8%)** | **+14** |
| Tier C | 93 | 106 | +13 |

**Cost: 271¢.**

### The 0.4 multiplier, checked

It over-predicts. The read-only delta said +54 leads would gain a name; 44
actually did, and 14 converted.

| basis | predicted at 0.4 | actual | implied multiplier |
|---|---|---|---|
| the 54 the delta forecast | +21.6 | +14 | **0.26** |
| the 44 that actually gained a name | +17.6 | +14 | **0.32** |

Two things to carry:

**The multiplier is 0.3, not 0.4.** The 0.41 measured earlier came from four
states' *niche-scoped* slices. A whole-state slice finds more names, and the
extra ones convert worse — they are the marginal matches, on businesses whose
domains are more often catch-all or absent. Use **0.3** for whole-state
estimates and 0.4 for niche-scoped.

**`registry-coverage-delta.ts` over-predicts naming by ~18%.** It asks "would a
registry officer be found", but the real stage then applies `applyNameDecision`
— name class, corroboration — which rejects some. The delta is an upper bound,
not a forecast. That is now known and quantified rather than assumed.

### What whole-state actually bought

The **reverse lookup finally works**:

| | car wrap (niche-scoped, 5 states) | NY (whole-state) |
|---|---|---|
| leads | 1,042 | 586 |
| forward matches | 69 | 128 |
| **reverse, county** | **1** | **42** |
| **reverse, statewide** | **0** | **8** |

The earlier report called the reverse direction "worth keeping, not worth
expanding" on the strength of 1 hit in 1,042. That conclusion was an artefact of
niche scoping: reverse lookup asks whether a person found on a website is an
officer of *any* nearby entity, and a slice containing only wrap-named companies
cannot answer it. With the whole state loaded it contributes **50 of 178**
matches — 28%.

**That retraction matters more than the +14.** It means whole-state coverage
changes what the pipeline can do, not merely how much.

---

## 3. ⚠ Preflight launch test — the feature is not ready

### What was actually wrong

`lib/preflight.ts` was a predictor with 13 passing tests, `preflight_runs` was a
table, and the UI had two panels reading it. **Nothing ever ran it.** There was
no `preflight:*` job and never had been — no path from a niche to a number.
`scripts/preflight-census.ts` is now that path, and `preflight_runs` holds five
real rows for the first time.

### The calibration

| niche / location | n | census | predicted | band | actual Tier A | in band? |
|---|---|---|---|---|---|---|
| med spa / Long Island | 75 | 12.0% | 6.3–9% | good | **1.3%** | **NO** |
| dental practice / Long Island | 79 | 26.6% | 6.3–9% | good | 6.3% | YES |
| vehicle wrap shop / NY | 100 | 19.0% | 6.3–9% | good | 9.0% | YES |
| car wrap / US | 1,042 | 19.5% | 6.3–9% | good | 7.4% | YES |
| practice mgmt SaaS / US | 149 | 38.9% | 6.3–9% | good | **10.1%** | **NO** |

**3 of 5 in band — and the number is meaningless, because every niche got the
same prediction.** A predictor that returns one answer for every input is right
whenever the answer happens to be right. Its discriminating power here is zero.

### Why: the predictor is being fed a rate it was not calibrated on

`SEED_CALIBRATION` holds three points — med spa 2.667%, dental 15.19%, wrap
13.0%, matching `HANDOFF.md` §11's "2→1, 12→5, 13→9". Those are counts of 2, 12
and 13 businesses.

Computing the same quantity from the data now gives **9, 21 and 19**.

Two independent attempts to reproduce the seed, both failed:

1. *On-domain, non-role address* (the plain reading, and what `crawl-site`
   actually stores): 9 / 21 / 19.
2. *On-domain and the local part matches a person named on the site* (stricter):
   6 / 15 / 11.

Neither is 2 / 12 / 13. **The seed points cannot be regenerated by any reading
of the current data, and no code produces them.** They were computed by hand or
by a script that no longer exists.

The consequence is mechanical: `POOR_MAX = 5` and `MODERATE_MAX = 10` were set
for a scale where the observations were 2.7–15.2. Every reproducible census
lands at 12–39, i.e. above `MODERATE_MAX`, so every niche is "good".

### And the census does not predict Tier A anyway

Sorted by census rate, under the one definition that exists in code:

```
12.0% → 1.3% A      19.0% → 9.0% A      19.5% → 7.4% A
26.6% → 6.3% A      38.9% → 10.1% A
```

Not monotonic — 26.6% yields less than 19.0%. On n=5 that is not evidence of an
inverse relationship, but it is not evidence of a usable one either.

### Verdict

**Do not ship the preflight as a predictor.** Ship it as a **census** — a
descriptive number with no band and no promise — and revisit prediction when
there are more points from a single, code-defined measurement.

The census itself is worth showing: "12% of these businesses publish a personal
address on their own domain" is true, reproducible, and directly relevant to
whether a niche is emailable. The band around it is not.

### Three bugs found on the way, all the same shape

Code written against an imagined schema rather than the real one:

* The UI computed the census as `on_domain_personal / addresses_seen`.
  `lib/preflight.ts` defines it as `businessesWithPersonal / businessesFound`. A
  niche where ten businesses each publish three personal addresses would have
  read as 100% reachable while ten businesses were. Now one shared, tested
  `censusRate` on both sides.
* Both UI panels and the census script tested `status === 'ok'`. The column's
  check constraint allows `running | complete | failed`. The insert failed
  outright; the panels would have silently shown "no census" for every real row.
* `PreflightRun.status` was typed `string`, which is what let that compile.

---

## 4. LinkedIn — the numbers, and why not yet

### The gap is real

SaaS naming, 149 leads: **56 named (37.6%)**, 93 unnamed. All 93 have a website.
Registry contributes **0** to SaaS — a company found by search has no postal
address, so there is nothing to scope a registry query by.

### SERP's LinkedIn path already runs, and yields 6%

`serp:owner` ran on 100 of them:

```
runs                100
runs with a candidate  6
candidates             6   all owner_grade
haiku calls           92
```

`ownerQueries` already issues `site:linkedin.com/in "<business>"`. So the
LinkedIn-via-SERP path is live and finding 6 per 100.

### The upside, stated honestly

93 unnamed leads. If a LinkedIn integration named half of them — a generous
assumption for a 20-month-stale scraper — that is ~46 names, converting at the
0.3–0.4 measured here to **+14 to +18 sendable**, taking SaaS from 23.5% to
roughly 33–35%.

That is material. It is also the most optimistic reading.

### Recommendation: do the cheap experiment first

Against that upside sit three costs, none of them engineering:

1. `LINKEDIN_ACCOUNTS` is empty. The accounts are yours to supply and yours to
   have banned.
2. StaffSpy's last release is 2025-01-06 — twenty months of LinkedIn front-end
   changes ago — and `tomquirk/linkedin-api` is still 404. Vendoring it means
   owning it.
3. Starting `linkedin-worker` makes eight workers against a ~15-slot session
   budget at 2 each. Something must be scaled down first.

**Before any of that**, there is a zero-infrastructure experiment: the SERP
LinkedIn query is currently `site:linkedin.com/in "<business name>"`, which is
the brick-and-mortar phrasing. For SaaS the useful shapes are
`"<company>" founder|CEO site:linkedin.com/in` and the company's own `/about`
and `/team` pages, which the crawler currently visits only if they are in the
first three pages it fetches.

If better queries take SERP from 6% to 15–20% on those 93, the LinkedIn
integration's remaining upside roughly halves and the case for burning accounts
gets much weaker. That test costs a query change and one re-run.

**I have not built LinkedIn, and I do not recommend building it until that
experiment has run.**

---

## 5. State of things

| | |
|---|---|
| registry-db | 1,176 MB · NY 1,532,811 · FL 166,570 · CO 30,259 · OR 7,045 · CT 4,950 |
| Supabase | ~25 MB of 500 |
| Backups | 2 dumps, 33 MB each, nightly cron installed, restore proven |
| Disk | 120 GB free |
| Tests | **367 pass**, both typechecks clean |
| Queue | empty |
| Verifalia | 271¢ spent this session |

### Follow-ups

1. **The SERP-query experiment in §4.** Cheapest remaining lever on SaaS yield.
2. **Whole-state the other four states.** NY took 31 minutes and 930 MB and
   turned the reverse lookup from 1 hit into 50. FL, CO, OR and CT are all
   smaller than NY.
3. **Re-derive the calibration** once a few more campaigns have run through the
   now-code-defined census. Until then the band should not be shown.
4. **`registry-coverage-delta.ts` is an upper bound** (§2), ~18% optimistic.
   Worth stating wherever its output is quoted.
