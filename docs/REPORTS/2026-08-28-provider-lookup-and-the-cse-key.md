# Provider lookup, and two measurements that came in smaller than projected

2026-08-28. The last item on the build list, plus a gate that failed.

---

## 1. The CSE key: abandoned

`GOOGLE_CSE_API_KEY` was tested and does not work — the Custom Search JSON API is
not enabled on that project, which is upstream of billing. The idea is closed.

The finding worth keeping is the second one: **it would not have helped anyway.**
SearXNG's `google cse` engine is not the Custom Search JSON API. Its own source
declares `use_official_api: False`, `require_api_key: False`, and scrapes
`google.com/cse/cse.js` with a third-party CX hardcoded into SearXNG. Our
settings set no `api_key` and no `cx`.

**The ~9-query ceiling is Google throttling a scraper, not an API quota.** No key
or billing change lifts it, and raising the pacing toward a "paid quota" would
only get the scraper blocked faster.

Pacing left at 16700 ms. Serper kept as the only paid SERP option, inert without
a key.

## 2. Provider lookup: built, and worth about a fifth of the projection

`src/sources/mailbox-provider.ts`, wired into `enrich:lead` **after** the free
sources and the whole pattern ladder have failed — so a paid request is spent
only on a lead the ladder was never going to solve. Capped per campaign, metered
into `source_costs` on hit *and* miss, because the hit rate is the number the
component is judged on.

**A provider address does not bypass the gate.** Hunter returns its own
`verification.status`; it is recorded and never trusted. The address joins the
candidate set and goes through Verifalia like any other. Hunter proposes,
Verifalia disposes — and on the 46 addresses where both had an opinion, they
**agreed only 45.7% of the time**.

### What it measures

Over the **189** Tier C leads with a name and a domain:

| | n | |
|---|---|---|
| returned an address | 46 | **24.3%** (assumed: 35%) |
| …of which **observed** (`sources > 0`) | **13** | 28% of hits |
| …of which inferred (`sources = 0`) | 33 | 72% of hits |

Verifying all 46 through our gate: **9 deliverable, 29 catch-all, 8
risky/invalid.** Taken at face value that is 38 of 189 — 20.1%, already well
under the projection.

### End-to-end it is smaller still

Running the real pipeline over 60 Tier C leads produced 8 sendable, of which the
provider's address won **twice**:

| address | what it was |
|---|---|
| `jamiefrew@carepatron.com` | `sources: 30`, not catch-all, **verified deliverable → Tier A**, and a local part no ladder would ever generate |
| `sheila.brody@greenspany.com` | `sources: 0`, catch-all domain, risky → Tier B on the concession rather than on evidence |

Those two cases are the entire component. It earns its place where the real
mailbox does not follow a guessable pattern **and** somebody has actually seen
it; everywhere else it re-proposes what `candidateLadder` already tried.

**So `PROVIDER_MIN_SOURCES = 1`** — only observed addresses are admitted. An
inferred address on a catch-all domain manufactures a Tier B row that looks like
evidence and is a guess, which is the failure mode the 6.4% bounce rate taught.

**Revised worth: ~+0.7 points globally**, against the +4 to +6 projected.

---

## 3. The bucket the whole analysis rested on was contaminated

The other six of those eight came back from **re-running the stage at all**.
Checking why turned up the more valuable finding of the day.

**20 of 201 Tier C rows had `verifalia_checks: 0`.** Verifalia had never run on
them. Their `email_status` was `unknown` — which §8.2 already records as *the
absence of a verdict, not a statement about a mailbox* — and at 10% of the
category, it had quietly become part of the denominator every ceiling number in
§13 was computed against.

**Re-running those 20: 10 became sendable (8 Tier A, 2 Tier B).** A 50%
conversion, for no provider spend and no new capability — a better return than
the provider produced on the same population.

`§13.2`'s "176 named and unmailable" was therefore overstated. The corrected
figure is **158**, all now carrying a real verdict, with zero unverified.

**The generalisation is the point.** Any figure derived by counting rows in a
terminal state is only as good as the guarantee that every row arrived there for
the stated reason. Nothing was watching for this one: the watchdog re-queues
`pending_verify`, and these rows were not that. **A Tier C row with zero
verification checks is a bug, not a result**, and is worth a monitor.

---

## 4. Where this leaves the numbers

| | before | after |
|---|---|---|
| sendable | 224 / 1,395 — 16.1% | **242 / 1,395 — 17.3%** |
| Tier A | 98 | 109 |
| Tier B | 126 | 133 |
| Tier C never verified | 20 | **0** |

Roughly a fifth of the gain is the provider; the rest is the mislabelled bucket.

**The build phase is closed.** Provider lookup was the last item and it is built,
measured and shipped, gated at `sources > 0`. What both of today's measurements
have in common is that the largest wins were *hygiene* — rows that never got a
verdict, and a paid lookup that mostly re-guessed what we had already guessed.
The pipeline's yield is now bounded by the populations it runs on (25% of
car-wrap businesses name anybody at all), not by anything left unbuilt.

Remaining work is niche selection and calibration, not engineering: run the
census on five to ten more campaigns so the preflight can finally be calibrated,
and treat further yield work as choosing better populations.
