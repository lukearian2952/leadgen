# Phase 5 — UI, reliability, tests, runbook

**Date:** 2026-08-27
**Queue item:** 3 — UI/reliability + tests + RUNBOOK per the brief; preflight and
budgets in the builder; `completed_low_yield` explained in the UI with the census
numbers.
**Status:** delivered. One finding in §1 was more serious than the item implied.

---

## 1. The headline: the UI was running the wrong pipeline

**The product's "Start Campaign" button ran v1.**

`useCampaignRunner` POSTed to the `campaign-orchestrator` Edge Function. That
function is still deployed and still works — and it drives **Google Places API
plus Apify actors**, writing into the same `leads` table the v2 worker fleet
uses. All eight v1 functions are ACTIVE:

```
campaign-orchestrator · step1-scrape-businesses · step2-enrich-contacts
apify-webhook · owner-lookup · campaign-watchdog · campaigns-create
campaign-export
```

So the only button a user could press ran the pipeline this entire rebuild
replaced — the one that produced the 6.4% bounce rate the v2 gate exists to
prevent — and billed the Places API to do it. Every measurement in this project
came from scripts; nobody had pressed the button since the fleet was built.

This is the identical hazard `HANDOFF.md` §2 records for v1's pg_cron watchdog,
which "once raced v2 and scraped 100 businesses through the Places API into the
same table". That one was defused by leaving the cron job unscheduled. This one
could not be, because it is the front door.

### The fix

`start_campaign_v2`, a `security definer` RPC. v2 has no HTTP surface — it is
driven by rows in `graphile_worker`, and the browser cannot be given write access
to that schema, because a client that could insert arbitrary jobs could run any
task with any payload. The function runs as owner and checks `auth.uid()` owns
the campaign, then enqueues `maps:discover` or `saas:discover` by niche.

`pause_campaign_v2` also **removes the queued jobs**. v1's Pause set
`status = 'paused'` from the browser and trusted the orchestrator loop to notice
on its next hop. v2 has no such loop, so the status alone would have been a
"paused" campaign running happily to completion — the status lying about the
system, which `HANDOFF.md` §10.4 rates worse than a crash because it looks like
an answer.

Verified: `authenticated` and `service_role` only, `anon` revoked on both.

**Still live and worth knowing** (now in the RUNBOOK): the v1 functions remain
deployed. `campaign-export` is still the export path and must not be deleted;
the others are one bookmark away from starting a v1 run.

---

## 2. The UI now shows what v2 produces

It rendered v1's `gate_passed` boolean, which cannot express the distinction v2
exists to make: a row that is sendable with a caveat is not the same as a row
that names someone we cannot reach.

| Now shown | Was |
|---|---|
| Four-way tier (A/B/C/rejected) per lead, with the caveat on hover | a checkmark |
| Stacked tier bar across the campaign | — |
| "Sendable (Tier A + B)" as the headline | "Owner-ready" from a stale counter |
| Corroboration count on a name | — |
| Residential bytes against the campaign budget | — |
| Cost per lead | total spend only |

Tier counts are derived from the loaded leads rather than read from
`campaigns.stat_*`, because those counters are written by `finalize` at the end
of a run: stale for a campaign in flight, absent for one that finished before
tiers existed.

Rows written before tiers carry only `gate_passed`, and nothing has backfilled
them — there are 3,615 leads and the older campaigns predate the four-way
verdict. Reading that boolean as A/rejected is faithful to what it meant.

---

## 3. `completed_low_yield`, explained in the niche's own numbers

The requested piece, and the one most worth getting right. `completed_low_yield`
is a terminal **success**: the run worked and the niche did not. Labelling it
"low yield" and stopping invites the reader to assume a bug and go looking for
one.

The panel puts the census next to the outcome. The rendered shape, with
placeholder figures — **not** a real census, see the caveat below:

> A *N*-business census of **<niche>** found ***X*%** of the addresses these
> businesses publish are personal ones on their own domain (*a* of *b*). That
> predicted ***lo*–*hi*% Tier A** (*band*). You got *Z*% sendable.
>
> *A business that does not publish a personal address cannot be emailed at one.
> That is a property of the niche, and no amount of crawling changes it.*

This is `HANDOFF.md` §11's central lesson — "measure the population before
concluding anything about the machine" — made visible at the moment someone is
deciding whether the machine is broken.

### ⚠ The census has never actually been run

**`preflight_runs` is empty.** The preflight was built and shipped as a product
feature in the previous phase (`fe791d5`), with 13 passing tests, and **no
census has ever been executed against a real niche.** So the panel above will
render its no-census fallback for every campaign that exists today, and both
this panel and the builder's (§4) are so far exercised only by their tests.

That is worth stating plainly rather than burying: a feature with tests and no
live run is exactly the shape Florida's date bug had — built, asserted against
the spec, never executed, wrong. Running one census against `med spa` /
`Long Island NY`, where the 75-business ground truth already exists, would both
populate the UI and check the predictor against a known answer. It costs about a
dollar.

---

## 4. The builder: census before spend, and a real budget

- **Census inline.** The preflight for the typed niche + location appears as you
  type, before the campaign is created — a `poor` band gets an amber warning
  suggesting a different niche *before* the budget is committed. The whole point
  of a preflight is that it precedes the run.
- **Residential cap**, defaulting to 2.5 GB, passed to `start_campaign_v2` and
  stored on the campaign. If the target × the measured maps rate exceeds the cap,
  it says so: discovery will stop early and return fewer leads than asked for.
- **Cost estimate** from measured per-business rates ($0.0066 maps, $0.0069
  SaaS; the builder uses $0.008, rounded up, because a builder that
  under-promises cost is the wrong way round).
- Campaigns are now inserted **directly under RLS** rather than through
  `campaigns-create` — a v1 Edge Function that only ever did that one insert.

---

## 5. Tests

**361 pass**, up from 289 at the start of this session. `tsc --noEmit` clean on
workers; the frontend builds clean.

The React app has **no test runner**: `npm install` fails in this environment
(no network), so vitest could not be added. Rather than leave the code that
decides *what a customer may send to* untested because of a package manager, the
pure tier logic was extracted to `src/lib/tiers.ts` — importing nothing but
types — and is exercised by the workers' vitest.

16 tests over the parts that would fail silently and expensively:

- v1-boolean fallback, including when tier and boolean disagree
- tier counting across mixed v1/v2 rows
- an unrecognised tier being ignored rather than counted as sendable
- **the sendable-rate denominator** — measuring against rows-with-a-verdict
  instead of rows-discovered is exactly how a 468-row export once read as a
  success. Asserted against both real runs.
- the 25% low-yield threshold at its exact boundary, and that an empty campaign
  is not called low-yield

**Not done: Playwright.** The brief names it. It needs a browser download, which
needs the network. Recorded rather than skipped silently.

---

## 6. `docs/RUNBOOK.md`

Symptom-first, for the person on the keyboard. It opens with the five traps that
have each cost real hours on this project — the unrelated production workloads
on the same box, the 4-hour graphile lock, the connection ceiling, the `.env`
quoting failure that silently drops every variable after `VPS_PASSWORD`, and the
standing two-measurements rule.

The incident sections are written from symptoms actually seen: zero discovery
bytes (check the Decodo quota *first* — it has already invalidated one
measurement), a campaign stuck in `running`, everything landing at
`not_deliverable:unknown`, SERP returning dictionary definitions, and the
database approaching the free plan's 500 MB read-only cliff.

It also carries the three budgets and their enforcement points, the measured
per-business baselines to compare a run against, the known SERP metering gap,
and §9's escalation table — the things that need a human decision rather than a
command.

---

## 7. What is not done

1. **Playwright** (§5) — needs network.
2. **Dead-letter requeue in the UI.** The architecture promises it; there is
   still no button. `dead_letter` currently holds 2 rows, both stale.
3. **The alert banner has still never been seen with a live alert.** It builds
   and is wired. Verifalia's 402 raised real alerts today, so the data exists to
   test it against — that is the cheapest possible verification and it was not
   done.
4. **No census has ever been run** (§3). The preflight feature is fully built,
   tested and unexercised, and `preflight_runs` is empty — so the two panels
   added this phase have never rendered with real data.
5. **`discovery_stage_for_niche` is a regex.** It routes "practice management
   SaaS" and "crm software" to search and "phone repair shop" to maps, which is
   right for every niche tried. It will be wrong for something eventually; the
   failure is visible (a SaaS campaign finding medical offices) rather than
   silent.

---

## 8. Session summary — all three queue items

| Item | Status |
|---|---|
| 1 · Registry coverage | **Done.** 2 states → 5, named-rate 18.5% → 43.4% in covered states. Tier A/B blocked on Verifalia |
| 2 · LinkedIn + SaaS discovery | **SaaS done** (149 leads, 37.6% named). **LinkedIn not built** — no accounts, 20-month-stale library, connection ceiling |
| 3 · Phase 5 | **Done**, minus Playwright |

**Bugs found and fixed across the session**

1. Florida's filing dates read backwards — `mmddyyyy`, not `yyyymmdd`. Survived
   because FL had never been ingested and the test asserted only the *shape*.
2. One malformed record aborting a 1.8 GB ingest.
3. `ERROR: #N/A` as a county name in Oregon's published data.
4. NY's registry slice scoped to the wrong niche — 95,866 rows, one extra name.
5. Four of five SearXNG engines captcha'd, invisibly, behind an HTTP 200.
6. `targetCount` capping inserts per run rather than per campaign.
7. A malformed URL stored as a lead's domain.
8. A marketing title stored as a business name.
9. **The UI running the v1 pipeline.**

**The one thing standing in the way:** Verifalia has no credits. It has now
withheld the headline number from two of the three reports.
