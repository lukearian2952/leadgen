# SaaS discovery, and the practice-management run

**Date:** 2026-08-27
**Queue item:** 2 — LinkedIn (vendored StaffSpy, hard limits, cooling, SERP
fallback) + SaaS discovery adapters (G2/Capterra/ProductHunt/YC via crawl; SERP
on for online niches). Run 100 "practice management SaaS" / "United States".
**Status:** SaaS discovery **built and run**. LinkedIn/StaffSpy **not built** —
§5 says why, and it is not a matter of effort. Tier A/B again **capped by the
Verifalia credit exhaustion**.

---

## 1. The run

Campaign `0880d44f-400c-4132-91ac-9c142a448390`,
"practice management SaaS" / "United States".

| | n | % of discovered |
|---|---|---|
| discovered | **149** | target was 100 — §4.3 |
| crawled | 149 | 100% |
| **named** | **56** | **37.6%** |
| Tier A | 1 | 0.7% |
| Tier B | 2 | 1.3% |
| Tier C | 49 | 32.9% |
| rejected | 97 | 65.1% |

**Named-rate 37.6%, against 18.5% on the car-wrap national run** — twice the
rate, on a niche with no registry coverage at all (§3.2). The naming half of
this pipeline works better on SaaS than on brick-and-mortar.

**Tier A+B is 3, and that number means nothing yet.** 47 of the 49 Tier C rows
are `not_deliverable:unknown` — Verifalia had no credits to check them with, the
same block as the registry report §6. The run cost **6.9¢** of verification
because there was nothing left to spend.

### Cost

| source | stage | cents | residential bytes |
|---|---|---|---|
| `site_crawl` | crawl | 81.5 | 2.26 MB |
| `serp` | serp | 13.7 | (not metered — §4.2) |
| `verifalia` | verify | 6.9 | — |
| `site_crawl:datacenter` | crawl | 0.0 | 135 MB, not billed |
| **total** | | **102.1¢** | |

**0.69¢ per business**, against 0.66¢ on the car-wrap run and a ≤2¢ target.
Residential is 8.0 MB for the whole campaign — 0.05 MB per business, against
1.47 MB on Maps discovery. **A SaaS campaign is ~30× cheaper in residential
than a Maps one**, because there is no Chromium driving a map.

### Where the names came from

| source | named |
|---|---|
| `site_crawl` | 50 |
| **`serp`** | **6** |
| `registry` | 0 |

---

## 2. What was built

`saas:discover` — a discovery stage for niches with no storefront, feeding the
existing `crawl:site → registry:match → [serp:owner] → enrich:lead` chain
unchanged.

### Why it is not a G2 / Capterra / ProductHunt / YC crawler

The brief names four directories. All four were checked live before anything was
written, from this machine and again through residential:

| Source | Result |
|---|---|
| **g2.com** | robots.txt **permits** the category pages — 403, Cloudflare managed challenge, residential included |
| **capterra.com** | same: robots permits, Cloudflare challenges |
| **producthunt.com** | Cloudflare challenge on *every* path, `robots.txt` included |
| **api.ycombinator.com** | HTTP 200, richly structured — but `robots.txt` is `Disallow: /` for every agent |

Two of them would require **defeating a JS challenge**, which is circumventing
an access control rather than crawling. The one that answers cleanly asks in its
robots file not to be read by machines. None is implemented, and that is a
decision rather than an omission — reversing it is a call for you, not for me.

Search is the remaining channel, and it is the one the architecture already
nominates: `resolveNicheFilter` turns SERP *on* for any niche matching no
brick-and-mortar rule, which is exactly the online/SaaS case.

---

## 3. Two findings worth carrying forward

### 3.1 The word a buyer types is not the word on the vendor's homepage

`"practice management SaaS"` across five query shapes returned **49** unique
vendors against a target of 100. Almost nobody describes their own product as
"SaaS" — they say *software*, *platform*, *system*. Searching the buyer's word
finds mostly people writing *about* the category.

Swapping the category word — same niche, three phrase variants × five intent
suffixes — took the same run to **170 candidates**. `nichePhrases()` does this
automatically for any niche ending in a category word, and leaves alone one that
does not: inventing "dental implants platform" would search for something nobody
writes.

Query shape mattered as much. "best X software" was tried first and returned
**six dictionary definitions of the word "best"** in its top ten. Buying-intent
suffixes — `pricing`, `"request a demo"`, `"free trial"` — appear on a vendor's
own pages and essentially nowhere else.

Junk is about a third of a typical result set: review aggregators outrank every
vendor by design (that is their business), and a niche made of ordinary English
words drags in dictionaries. `DIRECTORY_DOMAINS` and `REFERENCE_DOMAINS` are
sized from a real 36-host response rather than from imagination.

### 3.2 Registry naming does not apply to SaaS at all

`registry:match` ran on all 149 leads and named **zero**.

**All 149 have no state.** A SaaS company discovered from search has a domain
and no postal address, so there is nothing to resolve a county from and nothing
to scope a registry query by. The stage is not failing; it has no input.

This matters because item 1 just tripled the registry's contribution on
brick-and-mortar. **That gain does not transfer to online niches.** SaaS naming
rests on the site crawl (50) and SERP (6), and any future work on SaaS yield
should go there rather than into more registry states.

### 3.3 SERP earns its place on SaaS — the first time it has

`serp:owner` named **6 of 56**. On the 254-business brick-and-mortar runs it
produced 2 names, and on the two earlier online niches it produced **0**.

The 0 is explained by §4.1: four of five SearXNG engines were captcha'd, and
nobody had noticed because SearXNG answers 200 either way. With the upstreams
restored, SERP is contributing on exactly the niche type the architecture
predicted it would. `HANDOFF.md` §8.4's "SaaS is exactly where it should earn
its place" is now measured: it does, modestly.

---

## 4. Bugs found and fixed

### 4.1 Four of five SearXNG engines were captcha'd, silently

SearXNG makes its own outbound requests — they never went through `ProxyPool` —
so they left from the server's own IP. That IP was rate-limited and challenged:

```
brave       Suspended: too many requests
google cse  Suspended: too many requests
duckduckgo  CAPTCHA
startpage   Suspended: CAPTCHA
```

**The failure is invisible from outside.** SearXNG still answers HTTP 200 with a
`results` array, just a much worse one — ten results from Bing alone, six of them
dictionary definitions. Every SERP number taken before today was measured
through this.

`sources/serp.ts` has carried the warning since Phase 3 and named this exact
remedy. Through rotating residential: **39 results across three engines**
instead of 10 across one, and ~20 real vendor domains where there had been none.
Brave and Startpage still refuse; DuckDuckGo and Google CSE are back.

`settings.yml` is now rendered from `settings.template.yml` by
`infra/render-searxng-settings.sh` — the proxy must be configured inside
SearXNG's own settings file, which puts the Decodo password in it, so the
rendered file is gitignored and chmod 600.

### 4.2 SERP residential bytes are now unmetered — a new gap

SearXNG proxies internally, so its residential usage does not pass through
`ProxyPool` and is not counted. The campaign's recorded 8.0 MB covers the crawl
only. At roughly a few hundred KB per query and 15 queries per campaign the true
figure is small, but it is **not zero and not measured**, and the 2.5 GB
per-campaign residential budget is now enforced against an undercount. Logged as
a follow-up rather than fixed, because the honest fix is a meter in front of
SearXNG like `proxy-meter` in front of gosom.

### 4.3 `targetCount` capped inserts per run, not per campaign

A second discovery pass took a 49-lead campaign to **149** against a target of
100. Every funnel percentage in this report therefore has a denominator nobody
asked for. Fixed — the cap now counts leads the campaign already holds — but the
run reported here is the one with the overshoot, and the 149 are all real leads
for the niche, so they are reported rather than deleted to make the number tidy.

### 4.4 Two defects the tests caught while being written

* `extractDomain` falls back to string-munging when `new URL` throws, so a
  malformed result URL came back **as itself** — `"not a url"` would have been
  stored as a lead's domain, spaces included. Search results are third-party
  text; `isHostname` now validates before trusting.
* `vendorName` split a title on its separator only when whitespace *preceded*
  it, so `"RocketMatter: Legal Practice Management"` kept the entire marketing
  title as `business_name` — which `registry:match` then trigram-matches against
  company registrations.

---

## 5. LinkedIn / StaffSpy — not built, and why

**Three independent blockers, none of which is effort.**

**1. There are no accounts.** `LINKEDIN_ACCOUNTS` is empty. StaffSpy
authenticates as a LinkedIn user; without credentials it cannot run at all, and
those are yours to supply and yours to risk — the accounts get challenged and
banned, which is why the design calls for aged ones.

**2. The library is stale, and it is a scraper.** Verified live today:

```
cullenwatson/StaffSpy   326 stars   last push 2025-06-17   WTFPL
PyPI staffspy 0.2.25    released    2025-01-06
```

The last release predates **twenty months** of LinkedIn front-end changes.
`ARCHITECTURE.md` §8 already flags it as thinly maintained; what is new is that
the gap has widened and there is still no maintained alternative —
`tomquirk/linkedin-api` is **still 404**. Vendoring it means owning it, and
vendoring it *without accounts to test against* means writing several hundred
lines that cannot be run once before they are committed. That is speculative
work, not deliverable work.

**3. It breaks the connection ceiling.** Starting `linkedin-worker` makes eight
workers. Supavisor allows ~15 session-mode clients project-wide and each worker
holds 2, so the eighth crash-loops on `EMAXCONNSESSION` (`HANDOFF.md` §2).
Something must be scaled down first — a decision about the whole fleet, not
about LinkedIn.

**What exists instead, and works:** the SERP fallback that `ARCHITECTURE.md` §8
calls "the honest fallback". `ownerQueries` already issues
`site:linkedin.com/in "<business>"`, and with the engines unblocked (§4.1) that
path named 6 of this run's 56.

**Recommendation:** treat SERP-via-LinkedIn as the LinkedIn story until you have
accounts you are willing to burn. If you want StaffSpy, supply
`LINKEDIN_ACCOUNTS` and say which worker to scale down; it is then a day's work
with something to test against, rather than a week of guessing.

---

## 6. Verification is still the binding constraint

Second report running. 47 of 49 Tier C rows on this campaign say
`not_deliverable:unknown`, which is not a statement about those mailboxes — it
is the absence of a verdict.

Of the 149 leads, **56 were named** and the pipeline built candidate addresses
for them. Whether those become Tier A, Tier B or nothing is unanswerable until
the account is topped up. Both runs now have their most important number
withheld for want of a few dollars of credit.

Re-running afterwards costs roughly 0.3¢ per check.

---

## 7. Follow-ups

1. **Top up Verifalia.** It now blocks the headline number of two consecutive
   reports.
2. **Meter SearXNG's residential egress** (§4.2) — the per-campaign budget is
   enforced against an undercount.
3. **Raise the SaaS naming ceiling.** 93 of 149 were rejected
   `no_owner_first_name`: the vendor's site simply does not name a person on the
   pages crawled. For SaaS the places a founder's name lives are the About page,
   the blog byline and LinkedIn — not the registry (§3.2). That is where the
   next percentage point is.
4. **`MIN_QUERY_HITS` is 1 and untested.** The hit histogram for this run was
   120 domains seen once, 24 twice, 12 three times, and one fourteen times.
   Raising the floor would trade recall for precision; the data to decide is now
   recorded on every lead.

---

## 8. Verification of this work

- **345 tests pass** (up from 316), `tsc --noEmit` clean.
- 29 new tests for SaaS discovery, written against a **real** 36-host SearXNG
  response rather than an imagined one — which is how §4.4's two defects were
  found before the code ever ran.
- Every one of the four directory sources in §2 was fetched live, twice, before
  the decision not to crawl them.
- The run in §1 is a live end-to-end pass: 149 leads through discovery, crawl,
  registry match, SERP and enrichment, zero failed jobs.
