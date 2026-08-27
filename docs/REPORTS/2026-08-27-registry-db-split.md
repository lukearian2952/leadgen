# Verification unblocked, and the registry leaves Supabase

**Date:** 2026-08-27
**Covers:** the three decisions taken after the Phase 5 report — run the withheld
verification, move `registry_entities` out of Supabase, clear the stale job.
**Status:** all three done and verified.

---

## 1. The withheld Tier A/B numbers

Verifalia topped up to 2,503 credits. `scripts/reverify.ts` re-ran `enrich:lead`
for every lead that was **named and holding no verdict** — not every lead, because
a row with a real `Deliverable` or `Undeliverable` answer cannot change and
paying to re-ask it buys nothing.

**Zero rows remain unverified on either campaign.**

### Car wrap, 1,042 businesses, per state

"Before" is exact rather than estimated: `registry-coverage-delta.ts` recorded
the 51 lead ids that gained a name, and every one was `rejected` beforehand.

| state | n | Tier A → | Tier B → | A+B → | Δ |
|---|---|---|---|---|---|
| **FL** | 71 | 3 → **6** | 4 → **10** | 7 → **16** | **+9** |
| **OR** | 25 | 1 → **2** | 1 → **5** | 2 → **7** | **+5** |
| **CT** | 28 | 1 → **2** | 1 → **4** | 2 → **6** | **+4** |
| **CO** | 49 | 5 → **7** | 2 → **3** | 7 → **10** | **+3** |
| NY | 32 | 2 → 2 | 2 → 2 | 4 → 4 | 0 |
| other 24 states | 837 | 58 → 58 | 43 → 43 | 101 → 101 | 0 |
| **TOTAL** | **1,042** | **70 → 77** | **53 → 67** | **123 → 144** | **+21** |

**Sendable 11.8% → 13.8%.** Tier C rose 59 → 77: the other half of the same
story, since a newly-named lead either converts or becomes a name at an address
verification rejects.

### Practice management SaaS, 149 businesses

| | before | after |
|---|---|---|
| Tier A | 1 | **15** |
| Tier B | 2 | **20** |
| Tier C | 49 | 19 |
| **sendable** | **3 (2.0%)** | **35 (23.5%)** |

**Cost:** 78.6¢ car wrap, 105¢ SaaS. 184¢ total, against a 3,000¢ per-campaign
cap.

### Three things worth keeping

**Registry names convert at 41%.** 21 of the 51 new names became sendable. A new
name is worth **~0.4 of a sendable lead**, not 1 — that is the multiplier for
estimating what another state's registry is worth before buying it.

**Tier B gains twice what Tier A does** (+14 vs +7). Registry names attach to
catch-all and freemail domains more often than crawl-named ones do, so registry
expansion buys *sendable-with-a-caveat* disproportionately. Worth knowing before
promising Tier A volume from more states.

**SaaS out-converts brick-and-mortar end to end.** 23.5% sendable against 13.8%,
at 1/30th the residential cost. The earlier report called this niche cheaper to
discover; it is also the higher-yield one, which was not visible while
verification was down.

---

## 2. The registry moved out of Supabase

```
Supabase     276 MB → 24 MB      252 MB reclaimed
registry-db  241 MB              304,267 entities, ceiling 20 GB
```

Supabase is now at **~5% of the free plan's 500 MB**, and the ceiling that shaped
every registry decision so far — niche-scoped slices, `personOnly`, `trimRaw`, a
400 MB abort — no longer applies to the registry at all.

252 MB is more than the 239 MB the tables held, because `VACUUM FULL` also
compacted bloat accumulated across the session's ingests and re-matches.

### What moved, and what did not

| | Where |
|---|---|
| `registry_entities`, `zip_county`, `county_for_zip` | **registry-db** |
| `registry_ingest_runs` (new) | **registry-db** |
| campaigns, leads, businesses, contacts, queue, `job_runs`, alerts | Supabase |

`registry-db` is `postgres:17-alpine`, volume-backed (`registry-db-data`), 2 GB
memory limit, bound to `127.0.0.1:5433` like every other LeadGen service, schema
applied on first boot from a mounted file.

### Why it was safe

The registry is **entirely internal**. No RLS policy references it, no Realtime
subscription watches it, the frontend has never read it, and — the part that
made this a two-hour job rather than a rewrite — **no query ever joined it to a
Supabase table.** `registry:match` reads a lead, asks the registry about it,
writes the verdict back. Three statements before, three after. The boundary
already existed; this turned it into a network hop.

The match interface is unchanged, as required: same SQL, same trigram and GIN
indexes, same `county_for_zip`. Nothing downstream of `registry:match` knows
anything happened.

### Verified before anything was dropped

1. Row counts identical on both sides — 304,267 and 7,643.
2. Worker boots with `registry-db connected, entities: 304267`.
3. One live `registry:match`: matched `HIGH GRAPHICS LLC` at 0.74 similarity,
   named from `officer_1`, **and** ran the reverse lookup with a county hit.
4. A 20-lead batch across all five states: **20/20 succeeded**, 3 matched,
   2 named, 5 reverse lookups. No failures.

Only then was the Supabase copy dropped.

---

## 3. Two bugs this surfaced

### 3.1 A foreign key that could not survive the move

`leads.registry_entity_id` was `REFERENCES registry_entities(id) ON DELETE SET
NULL`. With the entities in another database that can never be satisfied: the
matcher finds an entity in registry-db, writes its UUID to the lead, and Postgres
rejects the write.

**Caught by step 3 above — one match run against the new database before the old
copy was dropped.** Had the drop come first, the symptom would have been every
`registry:match` in the fleet failing with a foreign-key error and no registry
data left to roll back to.

The constraint is dropped; the column stays as provenance. What is lost is
`on delete set null`, so a `registry_entity_id` may now outlive the row it names.
That is acceptable: nothing reads it back to fetch the entity — `registry:match`
re-derives the match from scratch every run, and the officer it chose is already
copied onto the lead.

### 3.2 The weekly refresh would have silently downgraded Florida

`registry:refresh` read each state's mode from `job_runs.detail.mode`. **The
ingest never wrote that field.** So FL's mode came back `null`, and the next
Sunday's refresh would have re-ingested it as `daily` — five business days of
filings — in place of the whole-state quarterly archive. 166,570 entities would
have quietly become a few hundred, and the only visible symptom would have been
Florida matching much worse for no apparent reason.

The tests I wrote for the refresh asserted that a quarterly mode is carried
forward, and they passed: they exercised the function with a mode present. The
gap was that nothing ever put one there. *A test proving code handles an input
correctly says nothing about whether that input ever arrives.*

Fixed twice over: the ingest now records `mode`, and the scope lives in
`registry_ingest_runs` in registry-db, beside the data it describes, so the two
cannot get out of step — losing one loses the other.

---

## 4. The stale job

`crawl:site` #2583, queued 2026-08-17, attempts 3/3 exhausted, failing on
`contacts_lead_id_fkey`. Its campaign still exists; its lead had been deleted, so
the job could never succeed. Confirmed orphaned, then deleted. **Queue is empty.**

---

## 5. Cost of this session

| | |
|---|---|
| Verifalia | 184¢ |
| Residential | 0 bytes — nothing re-crawled |
| Supabase reclaimed | 252 MB |
| Disk on the VPS | 1.1 GB volume, 121 GB free |

---

## 6. Follow-ups

1. **`registry-db` has no backup.** It is rebuildable from the adapters and
   `registry_ingest_runs` records the scope each state was loaded under, but FL
   is a 1.8 GB download and fifteen minutes. `docker compose down -v` would take
   it. A weekly `pg_dump` to disk would cost minutes to set up.
2. **The 20 GB ceiling has never been approached** — the current load is 241 MB.
   It is a good-neighbour limit on a shared box, not a measured one.
3. **Whole-state registry slices are now affordable** and were not before. The
   niche-scoping that produced the NY med-spa mismatch was forced by the 500 MB
   ceiling; with 20 GB, a state could be loaded once and reused across niches.
   That is the single biggest open improvement to named-rate, and it just became
   cheap.
4. **`preflight_runs` is still empty** — carried from the Phase 5 report. The
   census is built, tested, and has never been run.
