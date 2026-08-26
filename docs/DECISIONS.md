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
