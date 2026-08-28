# ZIP→county, the SERP provider switch, and where the ceiling is

2026-08-28. Four pieces of work, and one of them returned a clean negative that
is more useful than the thing it was meant to build.

---

## 1. FL reverse lookup: enabled, worth zero, and the diagnosis was half wrong

### What was believed

FL whole-state contributed 0 reverse matches where NY contributed 50 (28% of all
its matches). The recorded cause: `zip_county` held only NY and OR, and all
11,031,417 FL entities have `county = ''` because Sunbiz publishes city and ZIP
but never county. The recommended fix was a crosswalk plus a county backfill.

### What was built

**The crosswalk.** Census ZCTA→county, all 56 states and territories, 46,960
rows, `source = 'census'`, `county_for_zip` prefers it over the rows derived
from filings. Those derived rows were never a geography and it shows — they put
07306 (Jersey City NJ) in Suffolk, 10996 (West Point, Orange County) in
Saratoga, 27603 (Raleigh NC) in the Bronx. They are kept as a fallback.

**A query-time join, instead of the backfill.** `reverseLookup`'s entity filter
gained a branch resolving an entity's county from its ZIP when the registry
omitted it. This half is not optional: the crosswalk *alone* would have made
Florida worse, because leads would begin resolving to "Miami-Dade" while every
FL entity still failed `county = any($2)` — taking reverse from wrongly-broad to
exactly zero.

It is cheap because `officers @> …` is the driver and is served by the GIN
index: a specific first+last matches a handful of rows out of eleven million, so
the crosswalk is consulted for those. **Measured at 190 ms.**

### The backfill was abandoned, on measurement

`registry_entities.county` is an optimisation, not a correctness fix, and an
expensive one. Two lessons came out of trying:

The first attempt compared
`left(regexp_replace(postal_code,'[^0-9]','','g'),5) = $2` against an index on
`(state, postal_code)`. A functional expression cannot use that index: every one
of the 1,174 statements sequentially scanned 11M rows at **~44 s each**, 14 hours
total. Plain equality works for the 98.2% of FL codes that are already five
characters.

Even fixed and index-driven, it ran at **~5,500 rows/min** — 30 hours for 10.4M
rows. Not the plan's fault: every row update rewrites all seven indexes
including two GIN, against a 2 GB container with 512 MB of shared buffers and a
9.9 GB table. Dropping the two county indexes to make the updates HOT-eligible
was considered and rejected as a destructive change to a live production
database for an optimisation nothing needed. ~400k rows are done; there is no
reason to finish.

### The result: zero

| FL, n=71 | before | after |
|---|---|---|
| leads resolving a county | 0 | **45** |
| named | 47 | 47 |
| sendable | 20 | 20 |

**Because county was never the binding constraint.**

| | n |
|---|---|
| FL leads | 71 |
| crawled | 71 |
| with any name candidate | 47 |
| **with a `site_crawl` candidate carrying first *and* last** | **5** |
| people reverse looked up | 8 |
| reverse hits | 1 |

Reverse lookup only runs on people the crawl named — it asks whether a person
found on a website is an officer of a nearby entity, so a lead with no
crawl-named person has nothing to ask. **Five of seventy-one.** No amount of
registry coverage moves that.

The one hit was *High Tide Graphics* in **Volusia**, a small county — exactly
where the county-scope assumption holds.

## 2. A precision bug Florida exposed, in every state

The ambiguity guard applied only to the statewide fallback, on the reasoning
that "the county scope is what keeps a full-name match meaningful". True of NY's
counties. **Miami-Dade returns 200+ entities for `Maria Rodriguez` and 200+ for
`Jose Garcia`** — county-scoped, and no narrower than statewide for a common
name. The county path then took `rows[0]` of an arbitrary three, with `limit 3`
making "three" and "three hundred" indistinguishable.

It had not yet produced a wrong name only because the dense-county leads had no
crawl-named people to look up.

`STATEWIDE_MAX_ENTITIES` → `MAX_SHARED_ENTITIES`, applied to both scopes.
Re-running every lead holding a reverse-derived candidate: **5 county candidates
rejected as too-common**, 29 hits from 69 people checked, **sendable unchanged
at 224** — the five were not the winning name anywhere. Precision at no cost.

## 3. The SERP provider switch

The 16.1% founder-phrasing result was measured at one lead per 50 seconds, and
that pacing was a property of the script that happened to run it. It is now part
of the system: `sources/serp-provider.ts` puts SearXNG and Serper behind one
interface.

| | SearXNG | Serper |
|---|---|---|
| selected when | `SERPER_API_KEY` empty | key present |
| pacing | 16.7 s/query, process-wide | none |
| cap | none (paced instead) | 500 queries/campaign |

The pacer chains on a shared promise rather than sleeping inside a job, because
`serp:owner` runs at `WORKER_CONCURRENCY` and five parallel sleeps produce five
times the intended rate. The cap reads the same `source_costs` row the meter
writes, so budget and spend cannot disagree.

**SERP is metered now**, closing half of §7.3: `serp_queries` rows carry live
query count, response bytes and per-query cost. Verified live —
`units 2, proxy_bytes 10736, serp:searxng`. SearXNG's own upstream egress is
still uncounted; it leaves the box without passing `ProxyPool`.

## 4. Cleanup

**Three dead letters, all closed with a written reason.** The claim that
`dead_letter` was empty was wrong — three rows had sat there since 17 and 26
August. A `resolution` column now lets one be closed deliberately rather than
looking outstanding forever. Two were the depth-5 Maps measurements killed by
the old fixed 20-minute cap — which is the recorded reason §7.2 says "never
measured" — and one was the FL date bug, superseded by a successful whole-state
ingest. **0 outstanding.**

**The alert banner has now been seen live.** `scripts/alert-402-drill.ts` drives
the real `VerifaliaProvider` against a local stub answering 402; everything
downstream of the HTTP response is production code. The row is open, carries
`verifalia_payment_required` / `error`, is returned by exactly the predicate
`useAlerts` uses, and `alerts` is in the `supabase_realtime` publication so the
banner appears without a reload. A second firing deduped into `occurrences: 2`
rather than a second row. `VerifaliaProvider`'s base URL is now injectable,
which is what made the 402 branch reachable on purpose rather than only by the
accident it exists to report.

**The `SOCRATA_APP_TOKEN` warnings are gone.** Accepted as permanently empty:
the anonymous pool has completed every ingest attempted on it, NY whole-state
included. A warning nobody intends to act on trains people to ignore the log.

---

## 5. The ceiling

Full arithmetic in HANDOFF §13. The short version:

`sendable% = naming% × mailbox-conversion%`, and the niches split into two
populations that need different work. Car wrap (25.4% named, 54.7% converted)
and vehicle wrap are **naming-limited**. Med spa (56.9% named, **17.2%**
converted) and dental (59.5%, 31.8%) are **mailbox-limited** — they find the
person and cannot reach them. SaaS is the only niche good at both, which is why
it leads at 30.9%.

**176 businesses — 12.5% of everything processed — are named and unmailable**,
and their failure mode is nearly uniform: no mailbox was ever constructed that
verified. Of 209 Tier C rows, 205 have no owner mailbox at all; 1 risky, 0
invalid. Only 34 are catch-all, and catch-all is not itself a blocker.

**v2 has no provider lookup.** v1 had one. `PATTERN_LADDER_EXTRAS` measured zero
recovery for 2.6× the verification spend, which says the pattern ladder is
exhausted — not that the mailboxes do not exist.

Projected per 100 businesses, at an **assumed** 35% provider hit rate (the one
unmeasured input):

| niche | now | projected |
|---|---|---|
| practice mgmt SaaS | 30.9 | ~40 |
| dental practice | 18.9 | ~29 |
| vehicle wrap shop | 23.7 | ~26 |
| med spa | 9.8 | ~19 |
| car wrap | 13.9 | ~17 |

Globally 16.1% → ~20–22%. At 50% it is 22.4%; at 20% it is 18.6%, and **that
spread is worth more than any other open item** — which is the argument for
buying one provider month and measuring on the 176 before building anything
around it.

**Is the build phase done? Yes, except for one thing.** Everything the brief
calls machinery is built, deployed and has survived a restart; this phase's
failures were maintenance faults, not missing capability. But the largest single
loss in the pipeline is caused by a component v1 had and v2 does not. That is a
gap in the build, and it is the last one.
