# Decisions

Append-only. Newest last. One entry per decision that someone later would
otherwise have to re-derive — what was decided, what it rests on, and what
would overturn it.

---

## 2026-08-26 — Registry adapter priority is set by the car-wrap state distribution

**Decision.** Build state registry adapters in the order the 1,042-business
national car-wrap run actually distributes across states, not by state
population, and skip states whose bulk business-entity data is paid-only.

**Evidence.** Live count from `leads` for campaign
`67aaaad4-c23a-44fc-9e94-e059e7470e00`, coalescing `leads.state` over
`businesses.state` (1,042 rows, no unknowns):

FL 71 · IL 66 · CA 60 · IN 56 · KS 56 · MA 54 · CO 49 · AZ 43 · ID 43 · LA 42 ·
NC 39 · MO 37 · NJ 37 · IA 36 · MI 34 · GA 33 · AL 32 · NY 32 · MD 30 · CT 28 ·
OR 25 · AK 22 · KY 18 · MS 17 · PA 17 · MN 17 · AR 13 · OH 12 · TX 5 · TN 4 ·
VA 3 · NE 3 · WA 2 · SC 2 · DE 2 · RI 1 · NH 1

**Consequence.** CA (60) and IL (66) are the 2nd and 3rd largest buckets and are
both excluded as paid-only, so the reachable ceiling on this campaign is lower
than the distribution suggests. Recorded rather than worked around.

**What would overturn it.** A different niche with a different footprint. The
distribution is a property of *car wrap*, not of the pipeline — see the
benchmark-niche warning in `HANDOFF.md` §11.

---

## 2026-08-26 — Which states get an adapter, and why the rest do not

**Decision.** Five states have adapters: **NY, FL, CO, OR, CT**. That is not a
first instalment — it is, as far as a live survey can establish, close to the
whole set of US states publishing *free, bulk or API, officer-bearing* business
entity data. The rest are blocked for reasons that will not yield to more
engineering.

**How the survey was done.** Two passes, because the first one lied.

1. A published third-party matrix of bulk-data availability by state. It is
   useful for the paid/free split and **wrong about this project's best
   sources**: it lists Oregon under "no bulk download available" and New York as
   "portal not observable", while we ingest both from free APIs. It surveyed
   Secretary-of-State websites; the data is on the states' *open data portals*.
   Do not trust it alone.
2. A direct query of the Socrata catalog network (`api.us.socrata.com`) for
   business-entity datasets, then a live fetch of each candidate's schema and
   sample rows.

**Result of pass 2 — the Socrata route is exhausted.** Across the whole
federated network, the state business registries carrying person names are
`data.ny.gov`, `data.colorado.gov`, `data.ct.gov` and `data.oregon.gov`. All
four are adapted. There is no fifth.

**Verified and rejected, with the reason:**

| State | Leads | Verdict |
|---|---|---|
| CT | 28 | **Adapted.** 1.29M master / 1.78M principals / 1.31M agents, joined |
| OR | 25 | **Adapted.** 1.57M rows, one per associated name |
| MA | 54 | Search portal only, no bulk or API. Highest-value state we cannot reach |
| NC | 39 | Paid subscription, and the site **prohibits automated searches** |
| AK | 22 | Free CSV, but behind DataDome bot protection (403) |
| OH | 12 | Free CSV monthly, but behind Cloudflare (403) |
| IL, CA, TX | 66, 60, 5 | Paid-only, excluded by instruction |
| IN, IA, UT, MN, MI, GA, KY, NJ, NV, ND, OK, SD, WI, ME, HI, AR, ID | — | Paid bulk access |
| KS, MO, LA, MD, AL, AZ, MS, PA, and others | — | No bulk product at all |

**The consequence worth stating plainly.** The five adapted states hold **205 of
the 1,042** car-wrap businesses (19.7%). CA and IL alone are another 126 that a
budget decision, not an engineering one, puts out of reach.

**What would overturn it.** MA, AK and OH are the three worth revisiting. AK and
OH publish the data for free and merely wall the transport — a residential
session would fetch them, at the cost of scraping past a bot wall, which is a
different risk posture and was not taken unilaterally. MA has no bulk product
but does have a free public search, which the `lookup()` half of the adapter
interface already accommodates at one request per lead.

---

## 2026-08-27 — SaaS discovery is search, not directory crawling

**Decision.** `saas:discover` finds online-niche businesses through SearXNG.
The four directories named in the brief — G2, Capterra, ProductHunt, YC — are
**not** crawled.

**Evidence, all fetched live on 2026-08-26, from the Mac and again through
Decodo residential:**

| Source | robots.txt | Access |
|---|---|---|
| g2.com | permits the category pages | 403, Cloudflare managed challenge |
| capterra.com | permits the category pages | 403, Cloudflare managed challenge |
| producthunt.com | unreadable — challenged too | Cloudflare challenge everywhere |
| api.ycombinator.com | **`Disallow: /`** | HTTP 200, rich JSON |

**Reasoning.** Two of the four would require defeating a JavaScript challenge.
That is circumventing an access control, not crawling, and it is a different act
from fetching a business's own website through a residential IP — which the
crawl already does and which those sites do not resist. The fourth answers
cleanly and asks, in the one machine-readable place provided for the purpose,
not to be read by machines.

Residential was tested specifically to separate "our datacenter IP is blocked"
from "this site refuses automated access". It is the latter: the challenge is
served to residential exits too.

**What we do instead.** Search, which is also what the architecture already
nominates — `resolveNicheFilter` turns SERP on for any niche matching no
brick-and-mortar rule. Measured: 149 leads, 37.6% named, 0.69¢ per business.

**What would overturn it.** A commercial API from any of the four, or your
explicit instruction to crawl them anyway. This is a judgement about access, not
a technical limit, so it is yours to reverse.

---

## 2026-08-27 — SearXNG egresses through residential

**Decision.** SearXNG's own outbound engine requests go through Decodo rotating
residential. `searxng/settings.yml` is generated from a tracked template by
`infra/render-searxng-settings.sh`; the rendered file holds the proxy password
and is gitignored.

**Evidence.** From SearXNG's own `unresponsive_engines`, before the change:
brave and google-cse "Suspended: too many requests", duckduckgo and startpage
CAPTCHA. Four of five engines gone, and **the API still returned HTTP 200 with a
`results` array** — a software query answered with six dictionary definitions of
the word "best". After: 39 results across three engines instead of 10 across one.

**Consequence to watch.** SERP now spends residential bytes where it spent none,
and those bytes are **not metered** — SearXNG proxies internally, so they never
pass through `ProxyPool`. The 2.5 GB per-campaign budget is now enforced against
an undercount. Small today (~15 queries per campaign); a meter in front of
SearXNG, like `proxy-meter` in front of gosom, is the honest fix.

---

## 2026-08-27 — StaffSpy is not vendored yet

**Decision.** LinkedIn enrichment stays SERP-only. StaffSpy is not vendored.

**Reasoning — three blockers, none of them effort:**

1. `LINKEDIN_ACCOUNTS` is empty. StaffSpy authenticates as a LinkedIn user.
   The accounts are the user's to supply and the user's to risk.
2. Verified live 2026-08-27: StaffSpy last pushed 2025-06-17, last PyPI release
   2025-01-06 — twenty months behind LinkedIn's front end. `tomquirk/linkedin-api`
   is still 404, so there is still no maintained alternative. Vendoring it
   without accounts means committing several hundred lines that have never once
   been executed.
3. Starting `linkedin-worker` makes eight workers against a ~15-slot
   session-mode ceiling at 2 slots each. The eighth crash-loops.

**What would overturn it.** Accounts, plus a decision about which worker to
scale down. It is then a day's work against something testable.

---

## 2026-08-27 — The registries leave Supabase for a local Postgres

**Decision.** `registry_entities`, `zip_county` and the new
`registry_ingest_runs` live in **registry-db**, a Postgres container on the VPS.
Supabase keeps everything user-facing: campaigns, leads, businesses, the queue.

**Why.** Supabase stays on the free plan — 500 MB, and a project that reaches it
goes **read-only**, taking the whole fleet down rather than one job. The registry
was **239 MB of a 276 MB** database, and it is the only table that grows without
bound: five states of *niche-scoped* entities is 304k rows, and whole-state
slices across fifty states would be tens of millions. Every registry decision so
far has been shaped by that ceiling rather than by what the data is worth.

**Why it was safe to move.** The registry is entirely internal. No RLS policy
references it, no Realtime subscription watches it, the frontend has never read
it, and **no query joined it to a Supabase table** — `registry:match` reads a
lead, asks the registry about it, and writes the verdict back, which is three
statements and was always three statements. The boundary already existed; this
made it a network hop.

**Result.** Supabase 276 MB → **24 MB** (252 MB reclaimed — more than the tables
held, because `VACUUM FULL` also compacted accumulated bloat). registry-db is
241 MB with room to 20 GB. Row counts verified identical on both sides before
anything was dropped: 304,267 entities and 7,643 crosswalk rows.

**What it cost.**

* `leads.registry_entity_id` was a **foreign key** into `registry_entities`. It
  cannot be satisfied across databases and is now dropped. The column stays as
  provenance; it may outlive the row it names. Found by running one
  `registry:match` against the new database *before* dropping the old copy —
  which is the only reason it was a migration rather than an outage.
* Any script issuing a single statement over `leads` **and** `county_for_zip`
  now has to do it in two steps. `niche-campaign.ts` was fixed;
  `statewide-delta.ts` and `registry-dryrun.ts` are guarded to fail loudly
  rather than return an empty result, because a measurement that quietly reports
  zero is how this project has already drawn a wrong conclusion once.

**Also fixed on the way.** `registry:refresh` read its per-state scope from
`job_runs.detail.mode` — a field the ingest **never wrote**. FL would have been
refreshed as `daily` (five business days of filings) instead of `quarterly` (the
whole state), silently. The scope now lives in `registry_ingest_runs` beside the
data it describes, and the ingest records `mode`.

**What would overturn it.** Moving to Supabase Pro would remove the ceiling that
forced this, but not the reasons it is better: local disk is 121 GB against
8 GB, the round trip is a container hop rather than a pooled connection to
us-east-1, and the registry no longer competes with lead data for a shared
budget.
