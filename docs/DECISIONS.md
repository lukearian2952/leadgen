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
