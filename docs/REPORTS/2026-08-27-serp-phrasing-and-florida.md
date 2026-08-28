# SERP phrasing, and Florida whole-state

2026-08-27. Two pieces of work: the SERP query experiment HANDOFF §9 named as
the next action, and the Florida whole-state ingest §5.3 called the cheapest
large improvement available.

---

## 1. The SERP experiment

### The baseline was wrong, and the correction matters

§9 quotes the baseline as **6 candidates per 100 runs**. That is right for the
stage and wrong for the cohort. `serp:owner` ran on 100 leads of campaign
`0880d44f`, which were exactly the 93 that finished unnamed plus 7 that other
sources had already named — and **all 6 candidates came from those 7**.

Over the 93 leads the experiment actually re-runs, the brick-and-mortar
phrasing scored **0**. Any candidate at all is an improvement; the number to
beat is zero, not six.

### Three causes, not the one that was designed for

§9 proposed changing the query phrasing. Measurement before the change found
three separate reasons SERP returned nothing on SaaS, only one of which was
phrasing:

**a. The queries.** `"<business>" <town> owner OR founder` and
`site:linkedin.com/in "<business>"`. "Owner" is not the word a software company
uses, and a bare company name against `linkedin.com/in` ranks employees above
the two founders.

**b. The prompt.** `serpOwnerPrompt` says the result "must be about this exact
business **at this location**". A SaaS vendor has no location, so
`Location: unknown` turned that guard into a near-blanket instruction to return
nothing. This was measurable in the original run: **85 model calls returned 4
people in total** across 93 leads. The model was not being over-ruled by the
guards downstream — it was returning empty arrays.

**c. The crawl.** §9 says `crawl:site` "only fetches three pages, which are
usually `/`, `/pricing` and whatever it found first", and that `/about` and
`/team` are the fix. **That describes v1.** This crawler has had `/about` and
`/team` in `FALLBACK_PATHS` all along, with `PAGE_CAP = 6`, and the 93 unnamed
leads averaged **3.44 pages** each with 46 of them fetching four or more. What
was actually missing is the software-vendor vocabulary: `/company` and
`/leadership` appeared neither in the fallback paths nor in `PEOPLE_LINK_RE`.

### The run, and why its first result is not usable

Both changes shipped, and the cohort was replayed into a fresh campaign
(`1d8b278e`) rather than re-run in place — the baseline has to survive, and
`PgBudgetLedger` is per campaign so a 300¢ cap on a campaign that had already
spent would have blocked every check.

First result: **1 candidate in 89 runs.** Which was a measurement of the
infrastructure, not the phrasing.

`site:linkedin.com/in` is honoured by exactly one of the upstreams SearXNG
aggregates. Across that run:

| engine | results | with a `linkedin.com/in` URL |
|---|---|---|
| bing | 2,040 | 3 (0.15%) |
| google cse | 89 | 17 (19%) |
| duckduckgo | 6 | 0 |

**Bing silently discards the `site:` operator** and answers with the company's
own domain. A controlled probe then found the mechanism: Google CSE answers
about **nine** queries and is then suspended for ~2 minutes. `serp:owner` fired
267 queries in four minutes, so CSE was suspended for essentially all of it and
Bing answered 96% of the run.

This is the failure mode `searxng/settings.yml` already documents — the instance
still answers `200` with a `results` array, just a much worse one — and the one
HANDOFF §11 lists as having caused a retraction before. Two measurements
settled it: the engine split above, and the same query issued by hand on the
same instance returning 20 LinkedIn profiles.

### The result, measured at a pace CSE survives

Cache cleared, re-enqueued one lead every 50 seconds:

| | old phrasing | founder phrasing |
|---|---|---|
| runs | 93 | 93 |
| avg results per lead | 11.3 | 20.5 |
| **runs with an owner-grade candidate** | **0** | **15 (16.1%)** |

Cohort outcome, all of it net new against a baseline of zero:

| | n | of 93 |
|---|---|---|
| named | 18 | 19.4% |
| — by serp | 14 | |
| — by site_crawl | 4 | |
| Tier A | 8 | 8.6% |
| Tier B | 3 | 3.2% |
| **sendable** | **11** | **11.8%** |

Every named lead got a verification verdict; none was left `pending_verify`.
Total 128¢ across both runs, against the 300¢ cap — **the cap was never the
constraint, because naming is the bottleneck, not verification.**

Practice-management SaaS overall: **35 → 46 sendable of 149, 23.5% → 30.9%.**

### The decision it gates

§9's table: SERP reaching 15–20% means "LinkedIn's remaining upside roughly
halves. **Do not build it.**" 16.1% is inside that band.

**Recommendation: do not build LinkedIn.** Beyond the band being met:

- The 93 leads §9 sized LinkedIn's upside against are no longer 93. 18 are
  named and 11 are sendable, so the remaining pool is 75 and the upside on it
  is proportionally smaller.
- The measured cost of the alternative is a query change and one re-run.
- Everything §9 lists against building it still holds: `LINKEDIN_ACCOUNTS` is
  empty, StaffSpy is unmaintained, `tomquirk/linkedin-api` is 404, and an
  eighth worker does not fit the ~15-slot session budget.

**What to do instead, in cost order.** The SERP ceiling is now infrastructural,
not linguistic: one upstream honours `site:` and it sustains ~3.6 queries a
minute. A paid search API for the LinkedIn query alone — one query per lead —
removes the pacing constraint and is a config change, not a worker. That is
where the next SaaS naming point is, and it is a fraction of LinkedIn's cost.

---

## 2. A latent boot break, found by restarting

Six of seven workers crash-looped on the first `docker compose up` after the
registry moved out of Supabase:

```
registry-db is not configured. Set REGISTRY_DATABASE_URL …
  at requireRegistryDb (jobs/index.js:24)
  at makeRegistryIngestTask (jobs/registry-ingest.js:51)
  at buildTaskList (jobs/index.js:64)
```

`buildTaskList` constructed **every** stage's task into one map and filtered by
role afterwards, and `makeRegistryIngestTask` resolves the registry pool at
construction. So a crawl-worker, which has no registry pool and no reason to
want one, died before registering a single task. Only `registry-worker` is
given `REGISTRY_DATABASE_URL` in compose.

Nothing had restarted between the split commit and this one, so a deployed
system sat in a state where **any restart would have taken down six of seven
workers**. Fixed by constructing only the stages the role runs, which also keeps
`requireRegistryDb` an honest error for the registry role rather than a boot
failure for everyone else.

This is a fourth instance of the §11 pattern — built, tested, never executed.
The registry split was tested, and the thing it broke was reachable only by
restarting.

---

## 3. Florida whole-state

```
seen              12,808,196
written           11,031,417   (86.1% name a person)
skipped anonymous  1,776,779
FL rows           166,570  →  11,031,417
registry-db       1,176 MB →  9,930 MB   (cap 20,000)
wall clock        125 minutes
```

Recorded as `whole_state = t, mode = quarterly, name_contains = {}`, and
`registry:refresh` reads all three — so the weekly job carries Florida forward
as a whole-state quarterly load rather than re-ingesting it as five days of
filings. That is the exact trap §11 records; this time the ingest wrote the
field and it was checked afterwards rather than asserted in a test.

`registry-enqueue.ts` grew a `--whole` flag. NY was loaded by hand; the
remaining states should not have to be.

### The re-match

14 leads gained a name, matching the coverage delta's forecast exactly.

| FL leads, n=71 | before | after |
|---|---|---|
| named | 33 | **47** (+14) |
| named by registry | 25 | 39 |
| sendable | 16 | **20** (+4) |

**0.29 sendable per new name — the 0.3 whole-state multiplier holds.**

Two calibration notes:

**The delta did not over-predict here.** §5.2 records it running ~18% high on
naming. On Florida it forecast +14 and delivered +14. The likely reason is that
FL is the one adapter whose source states person-vs-company itself and carries
officer titles, so fewer candidates are lost to name-class rules afterwards. The
~18% figure was measured on NY, where the officer type has to be inferred. Treat
it as an NY figure, not a property of the script.

**The reverse lookup contributed nothing, and structurally could not.**

| | NY whole-state | FL whole-state |
|---|---|---|
| forward | 128 | 45 |
| reverse (county) | 42 | **0** |
| reverse (statewide) | 8 | **0** |

`zip_county` holds **only NY and OR**, and all 11,031,417 Florida entities have
`county = ''` — the source carries city and ZIP but not county, and nothing
backfills it. The reverse direction keys on county, so it has no input.

This caps what Florida whole-state was worth. §5.1 measured reverse at **28% of
all matches** once NY was loaded whole; Florida got the forward 72% and none of
the rest. **The single highest-value follow-up is a FL ZIP→county table plus a
backfill of `registry_entities.county` for FL** — the 11M rows are already
loaded and 99.8% of them carry a ZIP, so this is a join, not another ingest.

---

## 4. Corrections to earlier documents

- **"SERP baseline is 6 per 100"** — right for the stage, wrong for the cohort.
  On the 93 it was 0.
- **"`crawl:site` only fetches three pages … `/about` and `/team` are the fix"**
  — describes v1. This crawler already fetched both and averaged 3.44 pages of
  a 6-page cap. The real gap was `/company` and `/leadership`.
- **"registry-coverage-delta over-predicts naming by ~18%"** — an NY figure. On
  FL it was exact.
