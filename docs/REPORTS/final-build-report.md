# LeadGen v2 — final build report

Build phase closed 2026-08-28. This is what was built, what it produces, what it
costs, and which levers moved the number and which did not.

`OPERATIONS.md` is how to run it. `HANDOFF.md` is the current state.
`RUNBOOK.md` is what to do when it breaks. This document is the evidence.

---

## 1. Inventory

**1,395 unique businesses processed, 242 sendable — 17.3%.**

Deduplicated by business across campaigns, because the SaaS experiment replayed
93 businesses that already existed and counting both inflates every rate. The
per-niche rows sum to 245 rather than 242: car wrap and vehicle wrap overlap by
three businesses.

| niche | businesses | Tier A | Tier B | Tier C | rejected | **sendable** | **rate** |
|---|---|---|---|---|---|---|---|
| car wrap | 921 | 61 | 70 | 74 | 716 | **131** | **14.2%** |
| med spa | 174 | 13 | 18 | 33 | 110 | **31** | **17.8%** |
| practice management SaaS | 149 | 24 | 23 | 24 | 78 | **47** | **31.5%** |
| vehicle wrap shop | 93 | 8 | 14 | 5 | 66 | **22** | **23.7%** |
| dental practice | 74 | 5 | 9 | 22 | 38 | **14** | **18.9%** |
| **total** | **1,395** | **109** | **133** | **158** | **~1,000** | **242** | **17.3%** |

**Tier A** is verified deliverable — Verifalia said exactly `Deliverable`, the
domain has MX, not a catch-all, not a role inbox. **Tier B** is sendable with a
labelled caveat: a named owner on a catch-all domain whose address follows a
known pattern, or an owner-named freemail address at a business that runs on
freemail. **Tier C** is named but no mailbox we can stand behind. **Rejected**
never produced a usable name.

**Do not merge Tier B into Tier A in a send.** Tier B has no proof the specific
mailbox exists, only that the shape is right on a domain that reads its mail.
That distinction is the whole reason the tiers exist, and it is what replaced a
6.4% bounce rate.

---

## 2. Cost

**$20.62 recorded across 7,330 job runs**, all campaigns, whole project.

| niche | recorded spend | sendable | **¢ per sendable** | residential |
|---|---|---|---|---|
| car wrap | 984¢ | 131 | **7.5¢** | 1.78 GB |
| med spa | 403¢ | 31 | **13.0¢** | ~0 |
| practice management SaaS | 345¢ | 47 | **7.3¢** | ~0 |
| vehicle wrap shop | 141¢ | 22 | **6.4¢** | ~0 |
| dental practice | 188¢ | 14 | **13.5¢** | ~0 |
| **all** | **2,062¢** | **242** | **8.5¢** | 1.79 GB |

By source: **Verifalia 1,435¢ (70%)**, site crawl / Haiku 674¢, provider lookup
112¢, SERP 79¢. Google Maps and datacenter crawling record bytes at zero cash
cost.

### What this number does and does not include

**Included:** every model call, every verification credit, every provider
lookup — everything the pipeline meters into `source_costs` and `job_runs`.

**Not included, and it cannot be from inside the repo:** the residential proxy
bill. Bytes are metered precisely (1.79 GB total, essentially all of it the one
national car-wrap Maps run) but **no $/GB rate is recorded anywhere in this
codebase**, so multiply by your Decodo contract rate. At a typical $3/GB that is
~$5.40 total, which would put car wrap nearer 11¢ per sendable and leave the
other niches unchanged — they barely touch residential.

Also excluded: the VPS, which is shared with unrelated production workloads and
cannot be attributed.

### The shape worth remembering

**Verification is 70% of variable cost, and it is spent per *candidate*, not per
lead.** A named lead costs ~5.7 checks because the pattern ladder guesses six
addresses and verifies them all. That is why "named but unmailable" is expensive
as well as unproductive, and why `PATTERN_LADDER_EXTRAS` — 2.6× the spend for
zero recovery — stays off.

SaaS is the cheapest niche per sendable *and* the highest-yielding, because it
has no storefront to scrape: no Maps discovery, no residential bytes, and a
higher naming rate.

---

## 3. The levers, measured

Every row is a real measurement. **Negative results are the majority and that
is the useful part** — they are what stopped further spend.

### Worked

| lever | measured effect |
|---|---|
| **Whole-state registry (NY)** | 586 leads: named 237 → **281**, sendable 61 → **75**. Reverse lookup went 1 → 50 matches, **28% of all matches** — a whole-state slice changes *what the pipeline can do*, not just how much it finds |
| **Re-running never-verified rows** | 20 rows carrying a tier with zero verification checks → **10 sendable (8 Tier A)**. A 50% conversion for no spend, and the single best return measured |
| **SERP founder phrasing (SaaS)** | Owner-grade candidates on the unnamed cohort **0/93 → 15/93 (16.1%)**; 18 named, **11 new sendable**. Took SaaS 23.5% → 30.9% |
| **Crawl `/company`, `/leadership`** | 4 of the 18 names on that cohort. `/about` and `/team` were already crawled — the gap was software-vendor vocabulary |
| **Registry ambiguity guard on the county path** | 5 too-common candidates rejected, **sendable unchanged** — precision at zero yield cost |
| **Census ZIP→county crosswalk** | FL leads resolving a county 0 → 45 of 71. Also corrected live errors in the derived table (10996 was in Saratoga, is in Orange) |

### Did not work

| lever | measured effect | verdict |
|---|---|---|
| **Provider lookup (Hunter)** | 24.3% return an address (assumed 35%), but **only 28% of those were observed** rather than inferred. Won **2 of 60** end-to-end. **~+0.7 pts** | Built, gated at `sources > 0`. Do not scale spend on it |
| **FL whole-state reverse lookup** | **Zero** tier delta. Reverse runs only on crawl-named people, and the crawl names first+last on **5 of 71** FL leads | County was never the constraint |
| **FL county backfill (11M rows)** | ~5,500 rows/min → **30 hours**, for an optimisation a 190 ms query-time join already delivers | Abandoned mid-run |
| **LinkedIn** | Never built. SERP reached the 15–20% band that §9 pre-committed to as "do not build" | Correctly not built |
| **Google CSE paid quota** | Key returns 403 — API not enabled. And SearXNG's `google cse` is a **keyless scrape** with a third-party CX, so no key could have helped | Abandoned |
| **`PATTERN_LADDER_EXTRAS`** | Zero recovery for **2.6× the verification spend** | Off by default |
| **Preflight predictor band** | Returned the **same band for all five niches**. `SEED_CALIBRATION` cannot be reproduced from any reading of the data | Census shipped, band dropped |
| **`gbp_owner`** | 0 of 100 person-shaped | Removed |
| **Actor 3 / Apollo (v1)** | 401 on every call | Removed |

### Never tested

**Serper**, **Playwright**, and **depth 10 → 5**. Serper is wired and inert
without a key. Playwright would target the ~13% of crawls that fetch zero pages,
some of which are dead sites rather than JS-only. Depth is a bytes-vs-rows
tradeoff, not a yield one.

---

## 4. What bounds the number now

`sendable% = naming% × mailbox-conversion%`, and the niches fail in two
different places:

| niche | naming | mailbox conversion |
|---|---|---|
| car wrap | **25.4%** | 54.7% |
| vehicle wrap shop | **36.6%** | 64.7% |
| practice management SaaS | 49.7% | 62.2% |
| med spa | 56.9% | **31.3%** |
| dental practice | 59.5% | **31.8%** |

Car wrap and vehicle wrap are **naming-limited** — three-quarters of businesses
never yield a person's name at all. Med spa and dental are **mailbox-limited** —
they find the person and cannot reach them.

**Neither is an engineering problem any more.** Naming is bounded by what small
businesses publish about themselves; the three sources (site, registry, SERP)
are all built and all measured. Mailbox conversion is bounded by what is
verifiable, and the one component that could have moved it — a provider that
simply knows an address — was built and measured at +0.7 points.

**The remaining variance is niche selection.** SaaS yields 2.2× car wrap on the
same machine, at the same cost per sendable, because software companies name
their founders and publish reachable mailboxes. That is a targeting decision,
not a build.

---

## 5. Three patterns worth carrying to the next project

**Measure the population before concluding anything about the machine.** Med
spas were the benchmark niche and are close to worst-case for owner mailboxes.
Every early inference about *the pipeline* drawn from them was wrong in the same
direction, across three phases.

**A terminal state is only as good as the guarantee that rows arrive there for
the stated reason.** 10% of Tier C had never been verified at all. It was in
every yield figure the project quoted, and re-running those rows returned more
than the paid component built to solve the same problem.

**Two independent measurements before acting on a diagnosis, and check the tool
before believing it.** Every retraction in this project — "PTR
forward-confirmed", "Verifalia egress problem", "Google penalty box", "blocking
gstatic breaks discovery", "the reverse lookup is not worth expanding", and the
SERP experiment's own first result — came from acting on one reading. Three of
them were a quota exhaustion wearing a costume.
