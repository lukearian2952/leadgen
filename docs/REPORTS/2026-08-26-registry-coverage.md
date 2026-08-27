# Registry coverage — five states, and what that is worth

**Date:** 2026-08-26
**Queue item:** 1 — enable FL and CO, add every state with free bulk/API data,
re-run matching over the existing 1,042 car-wrap businesses.
**Status:** **complete.** Naming and Tier A/B both measured. The Verifalia block
described in §6 was cleared on 2026-08-27 and the withheld numbers are in §6.1.

---

## 1. The headline

Registry coverage went from **2 states to 5**, and on the existing 1,042-business
national car-wrap run:

| | before | after |
|---|---|---|
| named | 193 | **244** |
| named-rate | 18.5% | **23.4%** |
| named-rate *in the five adapted states* | 18.5% (38/205) | **43.4% (89/205)** |

`HANDOFF.md` §7 said 18.5% was "a floor, not the pipeline's ceiling" and that
the reason was registry coverage. That is now measured rather than asserted:
where the registry exists, it names **2.3× as many owners**.

The overall figure moves much less than the per-state figure because the five
adapted states hold only **205 of 1,042** businesses (19.7%). §4 says why the
other 837 are out of reach, and how much of that is a budget decision rather
than an engineering one.

---

## 2. What was built

| State | Source | Access | Person source | Named |
|---|---|---|---|---|
| **FL** | Sunbiz `cordata.zip` | public SFTP, 1.82 GB | 6 officer slots + agent | 90.5% |
| **CO** | `data.colorado.gov` 4ykn-tg5h | Socrata | registered agent | 81.4% |
| **OR** ✨ | `data.oregon.gov` tckn-sxa6 | Socrata | auth. rep + agent | 81.7% |
| **CT** ✨ | `data.ct.gov` ×3, joined | Socrata | **principals** + agent | 83.4% |
| **NY** | `data.ny.gov` | Socrata | 3 name columns, inferred | 41.0% |

✨ = new this phase.

**Connecticut is the best of the set.** It is the only adapter whose person list
is *principals* — the owners the business itself declared — rather than the
registered agent, who is very often a filing service. It averages 1.34 people
per entity against Oregon's 1.00, and 96% of probed entities were named.

**Florida is the richest.** 2.25 officers per entity, six typed officer slots,
and the source's own P/C flag for person-vs-company.

**New York is the weakest**, at 41% named, because it is the only source that
does not tell us whether a name is a person or a company — it is inferred from
three loosely-typed name columns. Every other adapter reads the answer off the
source.

### Rows loaded

```
FL  166,570      NY  95,895      CO  30,067      OR  6,933      CT  4,802
```

304,267 entities, all person-bearing, scoped to car-wrap name tokens.
Database **275 MB** of a self-imposed **400 MB** ceiling (§7).

### Weekly refresh

`registry:refresh` runs **Sunday 03:00 UTC** from the graphile-worker crontab —
registered and live (`_private_known_crontabs`, known since 2026-08-27 00:04).

It takes no configuration of its own. The scope for each state is read back out
of `job_runs.detail`, which `registry:ingest` already writes on every successful
run, so the refresh is definitionally "re-run what is loaded" and **cannot drift
from what is actually in the table** — which is precisely the failure mode §3
describes for NY. A state that has never been ingested is not refreshed: adding
a state is a deliberate act, not something a weekly job should start doing by
itself.

States are staggered 20 minutes apart rather than fired together. Five
concurrent ingests would each check the database-size ceiling against a database
the other four are still writing to, and all five could pass the check on their
way past it. Each enqueued ingest carries the same `REGISTRY_MAX_DB_MB` guard as
a manual one, and FL's `quarterly` mode is carried forward explicitly — the
default is `daily`, which is five business days of filings, so a refresh that
dropped the mode would quietly replace a whole-state slice with a week of it.

---

## 3. Named-rate, per state, before → after

Measured read-only: the forward trigram match and the reverse officer lookup
replayed against the current registry, with nothing enqueued and nothing spent.

| state | businesses | registry rows | named → | named ← | Δ | via forward | via reverse |
|---|---|---|---|---|---|---|---|
| **FL** | 71 | 166,570 | 9 | **33** | **+24** | 30 | 0 |
| **OR** | 25 | 6,933 | 3 | **13** | **+10** | 11 | 0 |
| **CO** | 49 | 30,067 | 14 | **22** | **+8** | 15 | 1 |
| **CT** | 28 | 4,802 | 4 | **12** | **+8** | 9 | 0 |
| **NY** | 32 | 95,895 | 8 | 9 | +1 | 4 | 0 |
| all others | 837 | — | 155 | 155 | 0 | — | — |
| **TOTAL** | **1,042** | | **193** | **244** | **+51** | 69 | 1 |

Per-state named-rate in the adapted states: FL 12.7%→**46.5%**,
OR 12.0%→**52.0%**, CO 28.6%→**44.9%**, CT 14.3%→**42.9%**, NY 25.0%→28.1%.

### Two things this table says that are worth keeping

**NY's +1 was a scoping bug, not a ceiling.** NY had 95,866 rows already loaded
and moved by one. The rows were ingested with **med spa** name tokens during
Phase 3 — so a car-wrap campaign was matching business names against a med-spa
slice. Re-ingesting NY under car-wrap tokens is what the +1 reflects, and NY's
low ceiling after that is the 41% person-rate above, not the scope. **A registry
slice is niche-scoped, and reusing one across niches silently under-matches.**

**The reverse lookup contributed 1 of 51.** Phase 4a found the reverse direction
worth "+1 name per ~100 lookups"; here it is 1 in 1,042. The forward match did
essentially all the work. The reason is structural: reverse lookup keys on a
person the *site crawl* already named, and on this niche the crawl named few
people that the forward match had not already found. It is not free either —
it is one or two indexed queries per crawled person. Worth keeping, not worth
expanding.

---

## 4. Which states got an adapter, and why the rest did not

Full reasoning in `DECISIONS.md`. The short version, and the part that matters:

**The Socrata route is exhausted.** A direct query of the whole federated
Socrata catalog network returns exactly four state business registries carrying
person names: NY, CO, CT, OR. All four are adapted. There is no fifth.

**A published third-party availability matrix was checked and is wrong for this
purpose** — it lists Oregon under "no bulk download" and NY as "not observable",
while both are free APIs we now ingest. It surveyed Secretary-of-State websites;
the data is on the states' open-data portals. Recorded so the next person does
not take it at face value.

| Not adapted | Businesses | Reason |
|---|---|---|
| **MA** | 54 | Free public search, but no bulk or API. The highest-value state we cannot reach |
| **NC** | 39 | Paid subscription, and the site explicitly prohibits automated searches |
| **AK** | 22 | Free CSV — behind DataDome bot protection (403) |
| **OH** | 12 | Free CSV monthly — behind Cloudflare (403) |
| **IL / CA / TX** | 66 / 60 / 5 | Paid-only, excluded by instruction |
| IN, IA, UT, MN, MI, GA, KY, NJ, NV, ND, OK, SD, WI, ME, HI, AR, ID | — | Paid bulk |
| KS, MO, LA, MD, AL, AZ, MS, PA, … | — | No bulk product at all |

**CA and IL alone are 126 businesses** — 12% of the run — out of reach for
budget reasons rather than technical ones. That is the single largest remaining
lever on the national named-rate, and it is a purchasing decision.

---

## 5. Bugs found

### 5.1 Florida's dates were being read backwards — and had never been noticed

FL's 8-digit date fields are **`mmddyyyy`**, not `yyyymmdd`. The published
layout names position 473 "File Date" and does not state the format — the third
omission in that spec, after the officer P/C flag and the fixed-width name
split, both of which have bitten this project before.

The wrong reading does not fail loudly. `08112026` becomes `"0811-20-26"`, which
*looks* like a date. It surfaced only because the quarterly archive carries
`11162011`, which Postgres rejected as month 20 — killing the ingest **after**
the 1.8 GB download had completed.

Two independent records settle the format:

* `doc/cor/20260815c.txt`, published 2026-08-15, carries `08112026` on every
  sampled record — 11 Aug 2026 as mmddyyyy, four days before publication.
  As yyyymmdd it is year 0811.
* The quarterly's `11162011` — 16 Nov 2011, or year 1116.

**Why it survived:** FL had been built and tested but never ingested
(`HANDOFF.md` §8.3), and the test asserted only
`/^\d{4}-\d{2}-\d{2}$/` — which `"0811-20-26"` satisfies. It now asserts the
value. *A shape assertion on a parsed field is not a test of the parse.*

### 5.2 One bad record killed a 1.8 GB download

The insert is batched, so a single unparseable date in four million records
aborted everything. A record with a bad filing date still names an officer,
which is the only thing this pipeline wants from it — the date is now dropped
and the row kept.

### 5.3 Oregon's county crosswalk contains a spreadsheet error

`ERROR: #N/A` appears as a county value in Oregon's own published release.
Stored unfiltered it becomes a county of that name, every lead in those ZIPs is
assigned to it, and the county-scoped lookup then misses *while appearing to
work*. The loader now asserts Oregon's **36 counties** rather than trusting the
row count; 22 of 496 pairs were rejected.

---

## 6. ⚠ Tier A/B is blocked: Verifalia is out of credits

**This needs your hands.**

The 51 newly-named leads were re-run through the real
`registry:match → enrich:lead` path. All 51 were named. Then:

```
Verifalia creditPacks: 3.000000    freeCredits: 0.000000
```

224 candidate addresses were submitted; **37 were verified before the credits
ran out**, and every subsequent batch returned HTTP 402.

**The system behaved correctly and loudly.** The 402 path raised
`verifalia_payment_required` alerts, marked the batch `unavailable`, and the
hybrid router attempted the verify-svc fallback — which cannot work, because
port 25 is blocked upstream (`HANDOFF.md` §9.1) and `VERIFIER=verifalia` has no
second path. Nothing here is a defect; the safety net did exactly what it is
for.

### What that means for the numbers

| | before | after | note |
|---|---|---|---|
| Tier A | 70 | 70 | — |
| Tier B | 53 | **56** | +3, the ones verified before credits ran out |
| Tier C | 59 | **89** | +30 named but unverifiable |
| rejected | 860 | 827 | −33 |

Of the 51 newly-named leads: **3 reached Tier B, 26 are stuck at
`not_deliverable:unknown` purely because there were no credits to check them
with**, and 18 fail the gate for reasons unrelated to verification (7 freemail,
6 no MX, 5 no website).

**Those 26 are the unmeasured upside.** On the original run's rates, a
meaningful share of them would be Tier A or B. Until Verifalia is topped up,
the Tier A/B half of this queue item cannot be answered — and per
`CLAUDE.md`, an unverified address must never reach the main CSV, so guessing is
not an option.

**To unblock:** top up the Verifalia account, then re-run
`npx tsx scripts/rematch-leads.ts 67aaaad4-c23a-44fc-9e94-e059e7470e00 /tmp/delta-after.json`.
Estimated cost at 0.3¢ per check: ~190 remaining checks ≈ **57¢**. The
per-campaign cap is 3,000¢ and 399¢ has been spent.

---

## 6.1 ✅ Resolved 2026-08-27 — the withheld numbers

Credits were topped up (2,503 available) and `scripts/reverify.ts` re-ran
`enrich:lead` for the 55 leads that were named and holding no verdict. **Zero
rows remain unverified.**

### Tier A/B, before and after, per state

"Before" is exact rather than reconstructed loosely: `registry-coverage-delta.ts`
recorded the 51 lead ids that gained a name, and every one was `rejected`
beforehand.

| state | n | Tier A → | Tier B → | A+B → | Δ |
|---|---|---|---|---|---|
| **FL** | 71 | 3 → **6** | 4 → **10** | 7 → **16** | **+9** |
| **OR** | 25 | 1 → **2** | 1 → **5** | 2 → **7** | **+5** |
| **CT** | 28 | 1 → **2** | 1 → **4** | 2 → **6** | **+4** |
| **CO** | 49 | 5 → **7** | 2 → **3** | 7 → **10** | **+3** |
| NY | 32 | 2 → 2 | 2 → 2 | 4 → 4 | 0 |
| all other states | 837 | 58 → 58 | 43 → 43 | 101 → 101 | 0 |
| **TOTAL** | **1,042** | **70 → 77** | **53 → 67** | **123 → 144** | **+21** |

**Sendable rate 11.8% → 13.8%.** Tier C rose 59 → 77, which is the other half of
the same story: of the 51 newly-named leads, 21 converted to sendable and the
rest are named at addresses that verification says are not deliverable.

**Conversion: 21 of 51 new names became sendable — 41%.** That is the number to
carry forward for estimating what another state's registry is worth: a new name
is worth roughly 0.4 of a sendable lead, not 1.

**Cost: 78.6¢** (399¢ → 477.6¢ of the 3,000¢ cap).

### Two things this changes

**Tier B gained more than Tier A** — +14 against +7. Registry names arrive
attached to businesses whose domains are catch-all or freemail more often than
the crawl-named population does, so the registry's contribution is
disproportionately *sendable-with-a-caveat* rather than *verified*. Worth knowing
before promising Tier A volume from registry expansion.

**NY gained nothing.** It gained one name (§3) and that name did not convert.
NY's 41% person-rate remains the weakest of the five adapters.

---

## 7. Storage — the constraint that shaped this work

**The Supabase org is on the free plan: a 500 MB database ceiling.** A project
that reaches it goes read-only, which takes down the whole fleet and not just an
ingest. The database was 121 MB before this work.

Whole-state ingestion is therefore impossible on this plan — full FL alone is
~4 M entities at roughly 0.84 KB each. Three changes made five states fit in
275 MB:

1. **`personOnly`** — an entity naming nobody cannot produce a name by either
   direction, so it was pure cost. It removed 59% of the NY slice, 19% of CO's,
   9.5% of FL's.
2. **`trimRaw`** — the per-adapter evidence payload was 30% of the table heap.
3. **A live ceiling** — `registry:ingest` checks `pg_database_size` every 20
   batches against `REGISTRY_MAX_DB_MB` (400) and stops, reporting
   `complete: false`. The difference between "this state is loaded" and "this
   state is loaded as far as the disk allowed" is something every consumer of
   a coverage number needs to see. It did not trip on this run.

The `zip_county` crosswalk is deliberately still built from **every** entity an
adapter yields, including the ones `personOnly` drops — it is 832 kB per 100k
entities and it is what lets a Maps business, which has a ZIP and no county, be
matched on county at all.

**A Supabase Pro upgrade ($25/mo, 8 GB) would remove this ceiling entirely** and
allow whole-state rather than niche-scoped slices — which would also make a
registry slice reusable across niches instead of the §3 scoping trap. Your call;
not taken unilaterally.

---

## 8. Follow-ups, in the order I would do them

1. **Top up Verifalia** and re-run the 51 (§6). ~57¢. This is the only thing
   standing between here and a complete answer to queue item 1.
2. **A national ZIP→county crosswalk.** FL, CO and CT publish no county, so
   `zip_county` covers only NY (7,169 pairs) and OR (474). Their reverse lookups
   are statewide-only, bounded at 2 entities, and so reject common names they
   should be able to place. The US Census ZCTA-to-county relationship file is
   free, static and would serve all 50 states in one load.
3. **`SOCRATA_APP_TOKEN` is still empty.** Free from
   `evergreen.data.socrata.com/signup`. Every ingest so far has run on the
   shared anonymous throttle pool.
4. **Decide on CA/IL** (§4) — 126 businesses, a purchasing decision.
5. **AK and OH** publish free data behind a bot wall. A residential session
   would fetch them; that is a different risk posture and was not taken
   unilaterally.
6. **`%SIGN%` matches `DESIGN`.** The car-wrap token list inflates every state's
   slice with design firms. It costs storage under a tight ceiling and does not
   cost precision, because `registry:match` still requires trigram ≥ 0.6 on the
   business name. Worth a word-boundary option before the next large ingest.

---

## 9. Verification

- **308 tests pass** (up from 289), `tsc --noEmit` clean.
- 17 new tests assert the OR and CT record shapes against records copied
  verbatim from the live APIs — the same discipline `fl-layout.test.ts` applies
  to Florida, and the reason §5.1 was catchable at all.
- Every source in §4 was fetched live before any adapter was written.
- The coverage delta in §3 is read-only: no crawl, no residential bytes, and the
  `google_maps` and `site_crawl` spend counters are unchanged from the original
  run.
