# LeadGen v2 — Handoff (Phase 4)

State as of 2026-08-17. Written so someone else (or me, later) can pick this up
without re-deriving anything. `ARCHITECTURE.md` is the design, `MIGRATION.md`
the v1→v2 plan; this file is *what is actually true right now*.

**One-line status:** Phase 3 is built and re-run end to end. Named-rate went
**24% → 40%** on the same 75 businesses. That **misses the ≥55% bar**, and §11
gives the measured reason per source. The more important result is that
**naming is no longer the binding constraint — mailbox construction is.** Tier A
did not move (1 → 1) while Tier B went 0 → 8.

Phase 2's result (75 businesses, 18 named, 1 Tier A, ~68¢) is kept below as the
baseline every Phase 3 number is measured against.

**Blocked externally:** outbound TCP/25 is dropped upstream of our NIC. Ticket
open with Hostinger; evidence in `docs/hostinger-evidence.txt`. Verification
runs on Verifalia meanwhile and this is not blocking Phase 3.

---

## 1. Stack state

### Server
`srv607166` / `92.112.184.200`, Ubuntu 24.04.3, 4 cores, 15 GB RAM.
Deployed at `/opt/leadgen` (rsynced from the Mac; not a git checkout).

**The box also runs unrelated production workloads** — Odoo ×2, n8n ×2,
narrative-radar, 3 Postgres, 1 Redis, nginx. Ports 22/80/443/3000/5432/5678/
5679/8069/8070/9120/9209 are theirs and must not be touched.

### Containers

| Service | Port | mem_limit | Notes |
|---|---|---|---|
| verify-svc | :8080 | 256m | `network_mode: host`, required to bind `VERIFY_IPS`. **Firewalled** — see §2 |
| searxng | 127.0.0.1:8888 | 512m | JSON API works. **Unused by any job — Phase 3 wires it** |
| crawl4ai | 127.0.0.1:11235 | 2g | up; **no job calls it**. Proxy env is correct but inert |
| maps-scraper | 127.0.0.1:8085 | 512m | gosom; working end to end |
| maps-worker | 127.0.0.1:9101 | 512m | |
| crawl-worker | (scaled) | 512m | |
| enrich-worker | 127.0.0.1:9106 | 512m | |
| verify-worker | 127.0.0.1:9107 | 512m | |
| scheduler | 127.0.0.1:9108 | 512m | `campaign:reconcile`, singleton — never scale |
| decodo-proxy | — | 128m | **`full` profile only.** Built on a wrong premise, retained. See §6.3 |

`docker compose up -d` from `/opt/leadgen`. Each worker builds its own image, so
`docker compose build` (no service arg) is needed after a code change or older
images silently keep running.

### Database
Supabase project `paasggeawsoctfgqbqrd`, Postgres 17. Migrations applied through
**`20260816000005_alerts`**:

- `…0003_worker_queue` — `job_runs`, `dead_letter`, `source_costs`,
  `verifier_ip_state`, `pg_trgm`, RLS, Realtime
- `…0004_phase2_entities` — `businesses`, `people`, `contacts`,
  `domain_patterns`, `tech_stack`, `serp_cache`, plus `leads.tier/score/…`
- `…0005_alerts` — `alerts` + `raise_alert()`, RLS, Realtime

`graphile_worker` schema is installed by the library at worker boot.

**v1's pg_cron watchdog stays unscheduled.** `select count(*) from cron.job` = 0.
Verify before every run — see §6.1.

### Connection budget
Supavisor allows ~15 session-mode clients project-wide and graphile-worker needs
session mode for `LISTEN/NOTIFY`. Each worker is capped at `maxPoolSize: 2`;
application queries use the transaction pooler (`:6543`). Six workers ≈ 12
session slots. **Adding replicas will exhaust this** and the new container
crash-loops on `EMAXCONNSESSION`. Phase 3 adds a registry-worker — budget for it
by scaling something else down, or accept 7 workers ≈ 14 slots, which is the
ceiling.

`db.<ref>.supabase.co` is **AAAA-only**; both URLs must use the pooler hostname.

---

## 2. Security — read before exposing anything

`verify-svc` binds `0.0.0.0:8080` because host networking is required for
outbound IP binding. It was **reachable from the internet with no
authentication** — anyone could drive `POST /verify` and burn our IP's
reputation, the one asset the verification design rests on.

Closed in `e20b5e6`: a `LEADGEN-FW` iptables chain entered only for `tcp dport
8080`, returning for loopback and RFC1918-on-a-bridge and dropping everything
else, on **both address families** (the listener is dual-stack). Installed as
`leadgen-firewall.service`, a systemd oneshot ordered after `docker.service`;
script at `infra/leadgen-firewall.sh`, idempotent.

Verified: from the internet `GET /healthz` and `POST /verify` return zero bytes
while the DROP counter advances; from `leadgen-verify-worker-1` both return 200.

Every other LeadGen port is published as `127.0.0.1:port` and was already
unreachable. **Any new service must follow that pattern or get a rule.**

Note for anyone testing this: `nc` from outside reports 8080 as "connected".
Hostinger's edge terminates inbound TCP — a port with nothing listening (8081)
*times out* rather than refusing. Only "does application data flow" is a valid
test from off-box.

---

## 3. Environment variables

| File | Location | Committed? | Contents |
|---|---|---|---|
| `.env` | Mac repo root **and** `/opt/leadgen/.env` | No | Everything the fleet reads |
| `.env.local` | Mac only | No | `SUPABASE_ACCESS_TOKEN`, `VITE_SUPABASE_*` |
| `.env.example` | repo | **Yes** | Template + rationale |
| `docs/ENV.md` | repo | **Yes** | name / required? / where to get it / who reads it |

`workers/src/config.ts` is the source of truth and refuses to boot when a
required var is missing. `workers/test/config.test.ts` asserts the list stays in
sync.

**`.env` values must be double-quoted when they contain shell metacharacters.**
Three passwords contain `(`, `)` or `'`; unquoted they silently abort
`set -a; . ./.env` partway and every variable after `VPS_PASSWORD` goes missing.
After any `.env` edit, confirm the *last* variable still reads.

### Currently set, and changed this phase
- `VERIFIER=verifalia` (was `hybrid`) — port 25 is blocked, so the self-hosted
  verifier cannot contribute. Revert to `hybrid` when Hostinger unblocks.
- `VERIFALIA_MAX_CENTS_PER_CAMPAIGN=800` (was 500).
- `DECODO_MAPS_STICKY_PORT` — optional, defaults 10042. Only read by the
  `full`-profile `decodo-proxy`.
- `MAPS_PROXY_REQUIRE_COUNTRY` — defaults to `DECODO_COUNTRY`. Hard-fails a
  scrape whose proxy exit is outside it. See §6.3.

Not set: `SOCRATA_APP_TOKEN` (Phase 3 wants it — free, from
evergreen.data.socrata.com/signup), `LINKEDIN_ACCOUNTS`.

### Credential hygiene (unchanged, still outstanding)
`SUPABASE_ACCESS_TOKEN` was pasted into a chat transcript and **should be
rotated**. v1 keys in a pre-`git init` `.env`: `APIFY_API_KEY` should be revoked;
`OPENAI_API_KEY`, `GEONIX_API_KEY`, `TELEGRAM_*`, `VPS_SCRAPER_*`,
`GOOGLE_CSE_*` are read by no code and should be revoked rather than rotated.

---

## 4. Built and tested

**89 Vitest tests + 18 Go tests pass; `tsc --noEmit` clean.**
`cd workers && npm test`. Go: `docker run --rm -v /opt/leadgen/verify-svc:/src
-w /src golang:1.23-alpine sh -c "go mod tidy >/dev/null; go test ./..."`.

| Area | Tests | Proven behaviour |
|---|---|---|
| `prober` (Go) | 18 | **stop-at-first-safe = exactly one RCPT and one connection**; catch-all short-circuit; policy-5xx ≠ invalid; block codes cool the IP and escalate; 3-consecutive-failure MX backoff and its expiry; 10-in-5-minutes IP cooling; hourly cap does not cool; ≤4 concurrent per IP; 1 connection per MX; dial counted exactly once |
| `verify/cooldown.ts` | 16 | 24h cooldown, hourly caps, round-robin, `allCooling` vs `allAtCap`, auto-recovery |
| `verify/hybrid.ts` | 8 | The four routing rules, budget cap, risky-before-unknown priority |
| `hybrid-fallback` | 8 | Whole-batch reroute when the primary **cannot run**; no reroute when it merely was inconclusive; cap honoured when Verifalia is primary; spend accumulates across batches |
| `verifalia-alerts` | 4 | 402/401 raise an alert and mark results `unavailable`; a 500 does not |
| `maps-wait` | 5 | ok-but-empty keeps waiting; `ok_but_empty` ≠ `timeout`; failure returns immediately |
| `long-island` | 5 | Membership, county assignment, Mt/St abbreviations |
| `lib/patterns.ts` | 15 | Pattern inference, one-candidate collapse |
| `config.ts` | 12 | Fail-fast lists all missing vars |
| `proxy/pool.ts` | 7 | Sticky port mapping, determinism, range safety |
| `verify/types.ts` | 9 | Tier assignment, score weights |

**Proven live:** graphile round-trip; `LISTEN/NOTIFY` over Supavisor; Decodo
sticky and geo-targeted exits; gosom scrape → CSV → filtered leads; Verifalia
verdicts with per-contact provider attribution; the alert dedupe (`raise_alert`
bumps `occurrences` to 3, opens a new row after acknowledgement); the MX backoff
and IP cooling firing on a real batch.

---

## 5. Phase 2 result — the clean run

Campaign `fd23a9e1-a5d9-4dd7-91a1-babcc0179e96`, "med spa" / "Long Island, NY",
target 100.

| Stage | n |
|---|---|
| discovered (raw CSV rows) | 100 |
| kept after geo + niche filter | **75** |
| crawled | 75 |
| named | **18 (24%)** |
| contacts with a verdict | 10 |
| Tier A / B / C / rejected | **1 / 0 / 9 / 65** |

Discovery drops: `type_mismatch` 24, `no_country_on_place` 1.

**Top reject reasons:** `no_owner_first_name` 36, `no_mx` 22, `no_website` 3,
`catch_all_low_score:35` 3, `mailbox_invalid` 3, `freemail:gmail.com` 2,
`junk_domain` 1.

**Cost — ≈68¢ for 75 businesses, ≈$0.009 each:**

| Item | Value |
|---|---|
| Crawl datacenter | 72.1 MB |
| Crawl residential | 0.25 MB (escalated on 67 units) |
| Haiku | 46.15¢ (28.45 crawl + 17.70 enrich) |
| Verifalia | 10 checks, 21.9¢ of an 800¢ cap (2.7%) |

Well inside the ≤$0.02/business target. **Verification is no longer a
bottleneck or a cost.**

**Geo: 75/75 on Long Island** (61 Nassau, 14 Suffolk).

**Provider attribution works:** every verified contact carries
`provider=verifalia`; verify-svc dial attempts were 0 for the run.

---

## 6. The four pre-Phase-3 findings

These were audits, not builds, and two of them contradicted the premise of the
task. **Read all four before planning Phase 3 — finding 6.2 changes what to
build.**

### 6.1 `no_mx` is real; the resolver is fine

All 22 `no_mx` domains, three resolvers, **zero disagreements**:

| Resolver | Domains with MX |
|---|---|
| VPS local (systemd-resolved → 1.1.1.1) | 0/22 |
| `dig @8.8.8.8` | 0/22 |
| `dig @1.1.1.1` | 0/22 |

Every one resolves A records identically everywhere. They are web-only domains
and site builders (`glossgenius.com`, `square.site`, `hopp.bio`, `bookjune.com`).
**No resolver fix, no re-tagging.**

**The freemail path is smaller than it looks.** 8 of the 22 publish a real
gmail — `coastalaestheticsny@`, `legacymedspa2@`, `skinmedspacontact@`,
`myciaobellaspa@`, `endoaesthetics@`, `aestheticmedicallounge@`,
`tatianalovestox@`, `contact.qualityaesthetics@` — plus 2 placeholders
(`user@domain.com`, `hi@mystore.com`) and 1 platform address.

But `freemailAllowed` requires the **owner's name** in the local part, and only
`tatianalovestox@gmail.com` (Tatiana Masone) qualifies. The rest are
business-named. So the strict rule recovers **~1 of 22**.

**Not implemented — this is a gate-policy decision, not a bug.** Relaxing it to
accept business-named freemail would recover ~8 more leads per 75 and is exactly
the kind of loosening that produced v1's 6.4% bounce rate. Decide deliberately.

### 6.2 The naming wall is the title gate, not crawl coverage

The premise was a crawl bug (JS nav, page cap). It is not.

| | n |
|---|---|
| leads with a person extracted from the site | **39** |
| leads named (owner-grade title) | **18** |
| **person found, rejected on title** | **21** |
| no person found at all | 15 (11 of them 0 pages / crawl error) |

126 about/team/staff pages were reached across 60 leads; the 6-page cap bound on
only 15. Coverage is fine.

**Titles rejected:** Esthetician ×3, Massage Therapist ×2, MD ×2,
board-certified Nurse Practitioner ×2, CRNA ×2, Physician Assistant, LMT,
hairdresser, Pilates Instructor, 7 blank, 4 "General Staff".

**Titles accepted:** Medical Director, CEO & FOUNDER, Owner, Chief Executive
Officer, Co-Founder, Founder, Managing Partner.

Concrete: Coastal Aesthetics found *Joseph Pham, board-certified NP*; Asunshine
found *Adriana Natividade, PA*; Coastal Wave found *Cortney Kucker, PA*. All
three ended unnamed.

**Med spa About pages list clinical staff, not titled owners.** Two consequences
for Phase 3, in §8.

### 6.3 gosom, the reject label, and the town list — fixed (`9869a30`)

- **gosom now requires a stable byte count across two consecutive polls.**
  Status is not sufficient and neither is non-emptiness: measured on the clean
  run, the worker read 1,038,254 bytes from a job already reporting `ok`, and
  the file was 1,043,361 a minute later.
- **`not_deliverable:safe` → `catch_all_low_score:<score>`.** `assignTier` used
  `chosen.is_catch_all || catchAll` while the label tested `chosen.is_catch_all`
  alone, so a deliverable address on a domain-level catch-all was labelled as a
  mailbox failure that never happened.
- **`lib/long-island.ts`** — full Nassau + Suffolk place list, deliberately
  separate from the 30-town *query* list in `locations.ts`, plus Mt/St/Ft
  folding. Using the query list to judge membership undercounted: the run scored
  57/75 when the truth was **75/75**.

**Also in this phase, and worth knowing (`bb6a729`):** the `decodo-proxy`
auth-forwarding container was built on a wrong premise. gosom runs its **own**
internal `[AuthProxy]` and *requires* credentials in the URL it is handed;
pointing it at a credential-free forwarder produced `failed to start auth proxy
… username and password are required` and killed a discovery run outright. It is
retained behind the `full` profile because it is correct and tested for any
Chromium-driving component that does not do its own auth. Nothing uses it.

The **exit-IP guard added alongside it earned its place and stays**:
`maps:discover` resolves and logs the proxy exit before starting a job and
throws if it is outside `MAPS_PROXY_REQUIRE_COUNTRY`. Two silent-corruption
traps it catches — a bare Decodo username yields a random global exit (first
test came out of Córdoba, Argentina under `DECODO_COUNTRY=us`), and a sticky
port holds its existing session *through* a country change, so a port with a
live foreign session must be swapped rather than reconfigured. Both produce a
successful scrape of the wrong country, which is worse than a failure.

### 6.4 `gbp_owner` — measured 0%, deliberately not built

gosom's `owner` column is 100/100 populated, and **0 of 100 are person-shaped**.
It is the business's own Google account display name:

```
Alex and Dee's Spa (Owner)      | Alex and Dee's Spa
Legacy MedSpa (Owner)           | Legacy MedSpa
VITRA Aesthetics Clinic (Owner) | VITRA Aesthetics Clinic
```

Wiring it as a name source and re-running the 75 would contribute exactly zero.
**Stopped at the measurement.** May be worth revisiting for niches where sole
practitioners use personal Google accounts (therapists, consultants, agents) —
it is a per-niche question, not a dead end in general.

---

## 7. Open problems

### 7.1 Port 25 is dropped upstream (external, not blocking Phase 3)
Root cause established by three independent methods — shell probes with a
control arm (`MX:25` 0/40 while `1.1.1.1:443` 40/40), packet capture (SYNs leave
`eth0` and are retransmitted seven times, nothing returns — no SYN-ACK, no RST,
no ICMP, while a 443 control handshakes in 5 ms on the same NIC), and the
prober's own dialler via `GET /debug/dial` (0/5 tcp4, 0/5 tcp6, 0/20 Outlook).

Port-specific, not host-specific (`mx1.improvmx.com:587` 81 ms and `:465` 85 ms
while `:25` times out) and provider-independent (Google, Microsoft and improvmx
fail identically and simultaneously). Both address families. It behaves like a
rate limiter with a small burst allowance, not a static block: after a long idle
a few connections succeed, then everything is discarded.

Hostinger has confirmed no guest-firewall block and agrees it is an upstream
IP-specific egress filter. Evidence for the ticket is in
`docs/hostinger-evidence.txt` (16 attempts, 41 flows, UTC, per-flow SYN
retransmit counts, raw tcpdump).

**Consequence:** `VERIFIER=verifalia`. Revert to `hybrid` when unblocked, and
expect verify-svc to be the cheap path again.

### 7.2 verifier IP is cooling
`92.112.184.200` is `cooling` until **2026-08-17 23:50 UTC**, reason `10 dial
failures within 5m0s across MX hosts`, `blocks_seen = 1`. **This is correct** —
port 25 genuinely is blocked, and the hardening did its job. It auto-expires.
Under `VERIFIER=verifalia` it is not consulted.

### 7.3 Implemented but still unproven
| Thing | Why unproven |
|---|---|
| `campaign:reconcile` | Ran without error, never exercised against a genuinely stalled fan-out |
| crawl4ai | Container up, proxy env correct, **no job calls it** |
| `people` table | Written by nothing; `businesses` and `contacts` are populated |
| `Transient` flag | Emitted by the Go prober; `enrich-lead.ts` still finalises transient failures rather than scheduling the retry the brief asks for |
| Alert UI banner | Component and hook build and are wired into `CampaignDetailPage`; never seen with a live alert on screen |

### 7.4 gosom yield
30 city queries at `depth: 10` collapsed to exactly 100 unique places — Long
Island towns overlap heavily, so results dedupe hard. 184 jobs completed, 25
failed (61 `target closed`, 27 `unexpected page type`, 12 timeouts, 6 × 403).
Raising `depth` or widening the town list is the lever if >100 is needed.

---

## 8. Phase 3 — next steps, in order

The brief is registry-worker (NY / FL / CO) **plus** the SERP owner lookup
pulled forward from Phase 4, then a re-run of the same 75-business campaign with
named-rate broken out per source and a **≥70% named** target.

**Finding 6.2 is good news for registry and bad news for the target.**

Good news: the 21 leads lost to the title gate are not missing a name, they are
missing an *owner-grade* one. That is exactly what `dos_process_name` /
`chairman_name` / `registered_agent_name` supply. Registry is aimed squarely at
the real wall rather than at a coverage problem.

Bad news: **≥70% is unlikely from site + registry + SERP on this niche.**
`ARCHITECTURE.md` §8.5 measured, on 800 Long Island wellness/aesthetic/med-spa
entities in the NY dataset, that **49.4% have a person-shaped name in at least
one field** — and that is the ceiling *before* any match loss. 53–56% of
`dos_process_name` values are the entity name repeated, others are commercial
agents (CT Corporation, Spiegel & Utrera), so the adapter must classify
person-vs-company per field. Matching "Radiance Med Spa" to "RADIANCE MEDICAL
AESTHETICS LLC" loses more, and DBA/trade names are absent from the dataset
entirely. §8.5's own estimate is that **registry realistically contributes
35–45% named**.

Against 24% today, the union of site + registry + SERP plausibly reaches
**55–65%**. Say so up front rather than reporting a miss afterwards.

The two honest levers for the remainder:
1. **Accept clinical titles.** At a med spa the NP, PA or MD frequently *is* the
   owner. Finding 6.2 shows 21 leads sitting behind this single rule. This is
   the cheapest large gain available and it is a policy decision, not a build.
   Consider a `title_tier` (owner-grade / clinical-principal / staff) rather
   than the current binary, with clinical-principal admitted at a lower score
   and corroboration required.
2. **LinkedIn** (Phase 4), which is where titled owners actually are.

### Ordered
1. **`SOCRATA_APP_TOKEN`** — free signup; anonymous requests share a throttled
   pool.
2. **registry-worker, NY first.** `data.ny.gov` `n9v6-gdp6`, 4,266,351 rows,
   verified live. Match on normalised name + **county** (100% populated), with
   `dos_process_city`/ZIP as tie-break — **not** name+city: `location_city` is
   only 8.3% populated. `pg_trgm` similarity ≥ 0.6. Port v1's `parseName` +
   `NON_PERSON_TOKENS` for the person-vs-company classifier.
3. **FL (Sunbiz quarterly bulk via SFTP) and CO (Socrata)** — both verified
   reachable in Phase 0.
4. **SERP owner lookup on the running SearXNG.** `"{business}" {town} owner OR
   founder` and `site:linkedin.com/in "{business}"`, Haiku extraction, accept
   only owner-grade titles corroborated by a second source. Cache in
   `serp_cache` (30 days) — it exists and is empty.
5. **Re-run campaign `fd23a9e1`'s 75** end to end. Report the standard format
   with named-rate per source (`site_crawl` / `registry` / `serp`) **and the
   union**, since sources overlap and the union is the number that matters.
6. **Watch the connection budget** — a seventh worker is the ceiling (§1).

### Before any run
- `select count(*) from cron.job` = **0** (v1's watchdog raced v2 once and
  scraped 100 businesses through the Places API into the same table).
- No Places API calls during the run.
- The exit-IP guard will hard-fail a scrape whose proxy leaves the US; if it
  fires, swap `DECODO_MAPS_STICKY_PORT` rather than re-configuring the same one.

---

## 11. Phase 3 result — registry + SERP, same 75 businesses

Campaign `0419ce66-259c-4dd0-9023-070cabb09a6b`, "med spa" / "Long Island, NY".

**Method note.** Discovery was *replayed* from campaign `fd23a9e1`'s own rows —
same place_ids, same businesses, same websites — rather than re-scraped.
gosom's 30 city queries at depth 10 collapse to ~100 unique places and *which*
100 varies run to run; a different 75 would move named-rate for reasons
unrelated to registry or SERP and make the per-source split uninterpretable.
Everything downstream of discovery was earned again from scratch: no names,
emails, tiers or verdicts were carried over.

**75/75 crawled, named and enriched. 0 failed jobs, 0 dead-lettered.**

### 11.1 Funnel

| | Phase 2 | Phase 3 |
|---|---|---|
| discovered / kept | 100 / 75 | (replayed) 75 |
| **named** | **18 (24%)** | **30 (40%)** |
| Tier A | 1 | **1** |
| Tier B | 0 | **8** |
| Tier C | 9 | 12 |
| rejected | 65 | 54 |

### 11.2 Named-rate per source, and the union

Owner-grade names each source was able to supply, over all 75:

| Source | Leads named | % of 75 | Won the row |
|---|---|---|---|
| `site_crawl` | 19 | 25.3% | 17 |
| `registry` | 11 | 14.7% | 11 |
| `serp` | 2 | 2.7% | 2 |
| **union** | **30** | **40.0%** | — |

Registry outranks site by design, so it won all 11 of its own and took 2 from
site. **The site crawl was flat (18 → 19): the entire +16pp is registry (+11)
and SERP (+2).**

### 11.3 Clinical-lead promotions: zero, and why

**0 of 30 named leads are `clinical_lead`. Every one is `owner_grade`.** The
machinery aimed at §6.2's 21 title-gate rejections contributed nothing, and
this was measured twice rather than guessed:

The site crawl proposed 38 clinical_lead candidates across **23 leads**. Of
those 23, 13 also had an owner-grade name (so the clinical one was never
needed). The remaining **10 ended `clinical_lead_uncorroborated`**. For those
10, all three corroboration routes were checked:

| Route | Fired |
|---|---|
| `registry_officer` | 0 of 10 — 9 had no registry match at all |
| `serp_owner` | 0 of 10 — 9 had no SERP candidate at all |
| `sole_person_ownership` | **0 of 10** |

The third is the interesting one. It needs exactly one person on the site *and*
first-person ownership language, and **the two halves never co-occurred**:

- 4 leads had exactly one person and no ownership voice (Dr. Debbie's
  Aesthetics, NY Face Place, Signature Aesthetics by Dr. Carney, Zoyya)
- 3 leads had ownership voice but 2, 3 and **17** people (Quality Aesthetics,
  Tatiana Masone, Pod Spa and Wellness)

That is the rule behaving correctly and conservatively, not a defect. A site
naming 17 people and saying "I founded this practice" identifies nobody.

**The cheapest unused signal is sitting in that table.** `Tatiana Masone, NP
Aesthetic Injector` — the *business name is the owner's name*, the site has
ownership voice, and it still went unnamed. Person-name-in-business-name is a
strong, free corroboration source and is not implemented.

### 11.4 Registry match confidence

24 of 75 businesses matched an entity (32%); 11 of those 24 yielded a
person-shaped officer (46%).

| Similarity band | Matches | Won the name |
|---|---|---|
| 0.60–0.70 | 3 | 2 |
| 0.70–0.80 | 3 | 2 |
| 0.80–0.90 | 3 | 0 |
| 0.90–1.00 | 15 | 7 |

mean 0.903 · min 0.607 · max 1.000

### 11.5 Freemail Tier B

**7 leads admitted**, all `safe`, all published on the business's own site,
none reaching Tier A. This is the single largest deliverable gain in the phase
and is why Tier B went 0 → 8. `no_mx` rejections fell **22 → 6**.

| Business | Address | Matched on |
|---|---|---|
| Aesthetic Medical Lounge | `aestheticmedicallounge@` | whole business name |
| Four Seasons Head Spa | `fourseasonsheadspa.ny@` | business token |
| Karasmatic Day Spa | `karasmaticdayspa@` | business token |
| Legacy MedSpa | `legacymedspa2@` | `legacy` |
| Lotus Skin Care Center | `debraquail@` | owner first name |
| Simplyme Aesthetics + Wellness | `simplymemedspa@` | `simplyme` |
| Skin by Bobbi | `skinbybobbid@` | `bobbi` |

One row was rejected by the rule as designed
(`freemail_local_part_unrelated`), which is the guard working.

### 11.6 Cost — 59.3¢ for 75 businesses, $0.0079 each

| Stage | Jobs | Cents | Avg s |
|---|---|---|---|
| `crawl:site` | 72 | 28.59 | 6.26 |
| `enrich:lead` (incl. Verifalia) | 72 | 23.70 | 1.03 |
| `serp:owner` | 44 | 6.98 | 2.09 |
| `registry:match` | 72 | 0.00 | 1.03 |

**Verifalia: 21 checks, 23.7¢ of an 800¢ cap (3.0%)** — 9 safe, 6 risky, 6
invalid. SERP cache: 88 queries stored, 0 hits (first run), 0 empty result sets.
Registry ingest: 18,614 NY entities for Nassau+Suffolk, 38.8% carrying a
person-shaped officer, 1,076 ZIP→county pairs learned.

### 11.7 Why the ≥55% bar was missed

**Registry underdelivered against its own forecast**: `ARCHITECTURE.md` §8.5
predicted 35–45% named from registry; it produced **14.7%**. The estimate
assumed the measured 49.4% person-shape ceiling would survive matching. It did
not — matching cost more than half of it, and the two losses compound:

- **32% match rate.** Two causes, both measured against the live API rather
  than inferred. *DBA/trade names are absent from the dataset*: `CIAO BELLA
  SKIN + SCALP` (Westbury) has six `CIAO BELLA` entities in Nassau/Suffolk and
  none of them is the med spa — they are a restaurant, a hair studio, a
  photographer, a boutique, a food service and an LLC. *Out-of-county
  registration*: `Brizel Med Spa` in Garden City, Nassau exists in NY DOS only
  as `BRIZEL BEAUTY SPA INC.` in **Kings**.
- **46% person-yield on the matches**, exactly the §4B problem — 13 of 24
  matched entities named only themselves or a commercial agent.

**SERP underdelivered outright: 2.7%.** 44 jobs, 88 queries, **zero empty
result sets** — SearXNG worked. But only 3 candidate names survived extraction
and 2 were owner-grade. Med spa SERP results are dominated by directory and
social listings (Yelp, Instagram, RealSelf) that name no owner, and the two
guards (the model's `source_url` must be one we supplied; the result must be
tie-able to this business at this location) correctly reject the rest.

**Site crawl was flat**, which was expected: same crawler, same owner-grade
rule.

### 11.8 The finding that matters more than the miss

**Tier A did not move: 1 → 1**, on 30 named leads instead of 18.

Naming is no longer the wall. Of the 30 named leads, the mailbox stage lost:
6 `mailbox_invalid`, 6 `catch_all_low_score`, 5 `no_mx`, 2 `freemail:gmail.com`,
1 `not_deliverable:risky`. Only one produced a verified, non-catch-all mailbox
on a domain the business controls.

**Phase 4 should not be more name sources.** The next constraint is turning a
known name into a deliverable address: pattern inference has almost no training
data (`domain_patterns` is nearly empty), and catch-all domains still cap
everything they touch at Tier B.

---

## 12. Phase 3 defects found by measuring, not by debugging

Four, in the pattern §10 describes. All were caught before the run.

1. **Florida officer names are three fixed sub-fields, not "First Last".** The
   42-char slot is `LAST`(20) + `FIRST`(14) + middle initial. Splitting on
   whitespace — the obvious reading, and what the published layout document
   implies — yields `first="Jover", last="Daniella"` for
   `"JOVER               DANIELLA"`: **a wrong name on every single Florida
   row.** The 14-char width was established by measuring where the padding run
   ends across all 1,553 person-typed officers in a real daily file (561 of 586
   end at exactly offset 14). Asserted in `test/fl-layout.test.ts` against four
   unmodified records.
2. **Florida supplies a per-officer P/C flag** the layout document also omits —
   1,553 persons vs 94 companies on the sample day. The source answers
   person-vs-company itself, which NY forces us to infer. Now trusted.
3. **Trigram similarity ≥ 0.6 alone produces confident false matches.**
   Measured on these exact 75 before the guard existed: `AIREM Aesthetic Spa &
   Plastic Surgery` → `AESTHETIC PLASTIC SURGERY, P.C.` (0.75), `Haven
   Aesthetics & Laser` → `LUXE LASER & AESTHETICS INC` (0.63), `Simplyme
   Aesthetics + Wellness` → `CLA AESTHETICS & WELLNESS LLC` (0.61). Each would
   have attached **a real person's name to the wrong business** — worse than no
   name. "aesthetic", "spa", "laser", "wellness" are most of both strings, so
   similarity was measuring the niche, not the business. Fixed with a
   distinctive-token requirement, plus a 0.9-similarity-and-matching-ZIP floor
   for names made entirely of niche words (`Med Spa`, `Laser Spa Studio`).
4. **The registry top-up was suspected broken and is not.** 39 leads triggered
   a targeted lookup and 0 matched, which looks like a bug. A direct statewide
   query confirmed it is correct behaviour: the entities genuinely are not
   there under those names in those counties (§11.7). A laxer top-up would have
   matched `CIAO BELLA HAIR STUDIO INC.` and produced a wrong owner.

Two config defects surfaced from worker boot logs:

- **`SOCRATA_APP_TOKEN` is still empty**, on the Mac and on the server. The NY
  ingest ran on the shared anonymous throttle pool and hit retry backoffs. Free
  from `evergreen.data.socrata.com/signup`; still the first item in §8.
- **`DECODO_COUNTRY` / `DECODO_STICKY_PORT_MIN` / `_MAX` were in `.env` but
  never passed through `docker-compose`**, so every worker logged them missing
  at boot. Behaviour was correct anyway — `config.ts` defaults country to `us`
  and the ports to 10001–10100 — but three false "optional config missing"
  warnings on every start is the noise that hides a real one. Fixed.

**`EMAXCONNSESSION` is real and arrived exactly where §1 predicted.** Seven
workers hold 14 of ~15 session slots; an ad-hoc session-mode client is the 15th
and is refused. Operational consequence: **scripts must use `DATABASE_URL`
(transaction pooler, 6543), not `DATABASE_URL_DIRECT`**, and must enqueue jobs
via `graphile_worker.add_job` in SQL rather than `makeWorkerUtils`. Both
`scripts/phase3-rerun.ts` and `scripts/phase3-report.ts` do this.

---

## 13. Phase 4a result — mailbox conversion, same 75 businesses

Campaign `4900719f-5203-4922-b443-9d3c5fae2759`. Same replay method as §11.
**75/75 crawled, named and enriched. 0 failed jobs, 0 dead-lettered.**

### 13.1 Funnel

| | Phase 2 | Phase 3 | **Phase 4a** |
|---|---|---|---|
| **named** | 18 (24%) | 30 (40%) | **32 (42.7%)** |
| **Tier A** | 1 | 1 | **1** |
| Tier B | 0 | 8 | **10** |
| Tier C | 9 | 12 | 12 |
| rejected | 65 | 54 | 52 |

**Tier A did not move again.** The phase was scoped to fix mailbox conversion
and it did not fix it.

### 13.2 Tier B by reason

| Reason | Leads |
|---|---|
| `freemail_business_verified` | 7 |
| `catch_all_named` (new) | **1** |
| `catch_all_scored:70` | 1 |
| `catch_all_scored:60` | 1 |

### 13.3 Pattern discovery recovered zero mailboxes — because there is nothing to discover

`mailbox_invalid` among named leads went **6 → 8**, not down. `domain_patterns`
gained **no** row from discovery; its only two rows are `verified_send`.

The mechanism is not broken — it has 22 unit tests and they pass. The raw
material does not exist in this niche. A census of every address the crawl saw
across all 75 businesses:

| | n |
|---|---|
| addresses seen | 140 |
| **on the business's own domain** | **17** |
| freemail | 29 |
| on-domain **and** personal (could teach a pattern) | **1** |

The single one is `marisa@radiancebodylab.info`, and its site named no person to
pair it with, so even that taught nothing. Everything else on-domain is
`info@`, `hello@`, `booking@`. **Med spa sites publish a role inbox and a
booking form, not staff addresses.**

The same scarcity gates the other new rule: `catch_all_named` requires the
domain to publish *any* mailbox, and with 17 on-domain addresses across 75
businesses it fired **once**.

### 13.4 The candidate ladder cost 2.6× and returned nothing

| | Phase 3 | Phase 4a |
|---|---|---|
| avg candidates per lead | 4.06 | **10.78** |
| Verifalia checks | 79 | **205** |
| `enrich:lead` spend | 23.7¢ | **61.5¢** |
| `mailbox_invalid` (named leads) | 6 | 8 |

Among leads named in *both* runs `mailbox_invalid` is unchanged — the two extra
failures are the two newly-named leads. **The four extra shapes recovered zero
mailboxes and nearly tripled verification spend.** Recommend reverting
`EXTRA_PATTERN_ORDER` from the default ladder; it is a measured loss.

### 13.5 The registry reverse lookup is the one thing that worked

**5 hits / 64 people checked = 7.8%.** Four named the winning row, and two of
those reached entity names the forward match could never have found:

| Business | Person | Registry entity | Tier |
|---|---|---|---|
| BEAUTIOLOGY | Marchelle Charles | `MARCHELLE CHARLES BEAUTY, LLC` | **A** |
| Simplyme Aesthetics + Wellness | Wiliana Lopez | `SIMPLYME MEDSPA, LLC` | B |
| The Skin Speakeasy | Gina Rose | **`UNBOUNDED BEAUTY LLC`** | B |
| Woodbury Medical Spa | Harris Hausen | **`SPINEAMERICARE MEDICAL, P.C.`** | C |

`UNBOUNDED BEAUTY LLC` shares no token with "The Skin Speakeasy". This is
precisely the DBA problem §11.7 identified, and keying on the *person* rather
than the business name solves it. **The run's only Tier A came from here.**

5 leads also gained a registered postal address (`address_source =
registry_reverse`).

**A reporting defect nearly buried this.** Corroboration was computed only from
*other* sources agreeing, so when a reverse hit won the row on registry
precedence its own list came back empty — the report said "leads named by
reverse lookup: **0**" while the reverse lookup was responsible for the only
Tier A. The feature worked; the number describing it did not. Fixed in
`name-decision.ts` with two tests, and it is worth remembering that this run's
headline number was almost wrong in the *pessimistic* direction.

### 13.6 name_in_business_name

**2 promotions, 1 genuinely new name** — `Tatiana Masone, NP Aesthetic Injector`,
the exact lead §11.3 flagged as the cheapest unused signal, now Tier B via the
freemail path. The other (Skin by Bobbi) was already owner-grade, so the
corroboration was redundant.

### 13.7 Net change P3 → P4a

**+3 named**: Dr. Debbie's Aesthetics, Signature Aesthetics by Dr. Carney (both
Deborah Carney, both `mailbox_invalid`), Tatiana Masone (Tier B).

**−1 lost**: Lotus Skin Care Center, named "Debra" from the site in Phase 3 and
unnamed here. Not investigated; most likely crawl variance on a single lead.
Flagged rather than explained.

### 13.8 Cost and spend

96.8¢ for 75 businesses = **$0.0129 each** (was $0.0079). Still inside the
≤$0.02 target, and the whole increase is the ladder. **Verifalia 61.5¢ of the
800¢ cap (7.7%)**, 205 checks. SERP cache: 109 queries, **83 hits** — the cache
is now paying for itself.

### 13.9 Registry ingest status — the token never landed

**`SOCRATA_APP_TOKEN` is still empty**, in the Mac `.env` and in
`/opt/leadgen/.env` (line 48 in both, `SOCRATA_APP_TOKEN=` with no value), and
the container confirms it. The ingest was re-run anonymously and produced
**18,614 seen / 18,614 written / 7,216 with a person — identical to Phase 3**,
so the missing token costs throughput and retry backoff, not coverage.

### 13.10 Where the wall actually is

Three phases have now failed to move Tier A off 1. Of 32 named leads: 8
`mailbox_invalid`, 6 `no_mx`, 3 `catch_all_low_score`, 2 `freemail:gmail.com`,
1 risky. The evidence across Phase 3 and 4a says the constraint is **not**
guessing strategy — a longer ladder and a discovery step both returned nothing.

What the data actually shows is that these businesses **do not have
owner-addressable mailboxes on their own domains**. They run on booking
platforms and consumer mail. The remaining honest levers are ranked by evidence,
not preference:

1. **Accept that Tier B is the product for this niche.** 10 of 75 are mailable
   with a named owner and a labelled caveat. That is the real yield.
2. **Reverse registry lookup is under-exploited** — 7.8% hit rate on a naive
   exact-name match, no fuzzy matching, no adjacent-state search, and it
   already produced the only Tier A.
3. **A different niche.** Med spas were chosen as the benchmark and are close
   to the worst case for owner mailboxes.

---

## 14. Niche validation — is the constraint the pipeline or the niche?

Three campaigns, same pipeline, no new sources.

| metric | med spa / LI | dental / LI | vehicle wrap / NY |
|---|---|---|---|
| businesses kept | 75 | 79 | 100 |
| with a website | 96.0% | 82.3% | 87.0% |
| **named** | 32 (42.7%) | **41 (51.9%)** | 34 (34.0%) |
| **Tier A** | **1** | **5** | **9** |
| Tier B | 10 | 8 | 14 |
| Tier C | 12 | 23 | 5 |
| **Tier A+B (sendable)** | 11 (14.7%) | 13 (16.5%) | **23 (23.0%)** |
| named by site_crawl | 19 (25.3%) | 8 (10.1%) | 19 (19.0%) |
| named by registry | 15 (20.0%) | **22 (27.8%)** | 19 (19.0%) |
| named by serp | 2 (2.7%) | 0 | 0 |
| addresses seen by crawl | 140 | 81 | 196 |
| on own domain | 17 | 29 | 34 |
| **ON-DOMAIN PERSONAL** | **2** | **12** | **13** |
| businesses with ≥1 | 2.7% | 8.9% | 9.0% |
| reverse: checked / hits | 64 / 5 (7.8%) | 129 / 13 (10.1%) | 44 / 1 (2.3%) |
| cost per business | $0.0129 | $0.0167 | $0.0136 |
| failed pipeline jobs | 0 | 0 | 0 |

### 14.1 The answer: the niche, and the predictor holds

**On-domain personal addresses 2 → 12 → 13. Tier A 1 → 5 → 9.** Monotonic
across three niches. The number nominated in §11.8 as predicting Tier A does
predict it.

**Named-rate does not.** Wrap has the *lowest* named-rate of the three (34.0%)
and the *highest* Tier A (9) and highest sendable share (23.0%). Med spa has a
higher named-rate than wrap and one ninth the Tier A. Naming and mailbox
conversion are independent problems, and Phase 3 solved the wrong one first.

The pipeline is not the constraint. Given businesses that own their mail, it
converts them.

### 14.2 Where the names come from is niche-specific

- **med spa** — site-led (19 site vs 15 registry). Marketing sites with staff
  bios and no filing under the trade name.
- **dental** — registry-led (**22 registry vs 8 site**). Practices file as
  "SMITH DENTAL PC" and their sites are template brochures.
- **wrap** — evenly split (19 / 19).

A single naming strategy is wrong for all three. This is an argument for
keeping every source on rather than tuning one.

**SERP named 0 in both new niches** (2 in med spa). Across 254 businesses it
has produced two names. On this evidence it does not earn its place.

### 14.3 Tier B composition tracks the same thing

| | med spa | wrap |
|---|---|---|
| `freemail_business_verified` | 7 | 8 |
| `catch_all_named` | 1 | **6** |

`catch_all_named` requires the domain to publish a mailbox. Wrap domains do
(34 on-domain addresses), so the rule fires six times; med spa domains do not,
so it fires once. Same rule, same code, different niche.

### 14.4 Statewide reverse fallback — measured, small, real

Measured twice, and the first measurement was a trap. On dental it initially
returned **0 extra hits from 104 queries** — because `registry_entities` held
only Nassau+Suffolk, so "statewide" was the same query. The feature was inert
for want of data, not broken.

After ingesting statewide (NY now 91,787 rows, 63 counties):

- **dental**: 1 extra hit / 103 statewide queries, 0 rejected as a common name.
  Newly names *All City Cosmetic Dental Care* (Suffolk) via `ALLCITY COSMETIC
  DENTAL CARE, P.C.` filed in **New York** county.
- **wrap**: 1 extra hit / 42 statewide queries, 0 rejected. Wrap's *only*
  reverse hit came from the fallback.

Cost is indexed jsonb containment queries and $0 external. Keep it on.

### 14.5 Discovery is the fragile stage, and it cost three attempts

The wrap campaign took four runs to produce a result. Worth recording because
none of it was the pipeline downstream of discovery:

1. **Operator error** — I restarted the fleet mid-scrape. graphile holds a
   stale lock for 4 h; the job had to be cleared from
   `graphile_worker._private_jobs` by hand. **Never restart a worker while a
   `maps:discover` is in flight.**
2. **Phrasing.** `"vehicle wrap shop in {city}"` returned 8 rows across 48
   queries. Measured against `"car wrap"` / `"vehicle wraps"` on the same two
   cities at the same moment: 9 rows vs **19**. The trade word is "wrap";
   "shop" narrows it to nothing. Now in `nicheQueryVariants`, defined only
   where measured.
3. **Query count.** 48 concurrent queries made gosom fall over — 71 `target
   closed`, 49 `unexpected page type`, a run of 403/502s. Capped at 36
   (`MAPS_MAX_QUERIES`). Fewer, denser queries beat more, thinner ones.
4. **Our own patience.** Both retries timed out at 20 minutes; the scraper job
   reached `ok` with **182 rows** minutes later. The wait now scales with query
   count, and `maps:discover` accepts `existingJobId` to adopt a scrape that
   finished after we gave up — which is how this run was finally completed,
   without a fourth scrape.
5. **The category filter** dropped 4 of the first 8 as `type_mismatch` — it was
   rejecting the exact trade it was aimed at, because gosom's category
   vocabulary is not Google Place types. Niche rules now carry free-text
   `hints`.

The 8 → 182 improvement is items 2 and 3 together.

### 14.6 What this means for Phase 4 proper

1. **Sell into niches that own their mail.** The census is a one-crawl
   qualifier: run 20 businesses, count on-domain personal addresses, and the
   Tier A rate follows. That is worth building as a pre-flight check.
2. **Med spa is close to the worst case** and was the benchmark for three
   phases. Every conclusion drawn from it about the *pipeline* was
   contaminated by the niche.
3. **SERP is not earning its cost** — 2 names in 254 businesses.
4. **Discovery, not enrichment, is where runs fail.** Every failure in this
   phase was a scrape; the queue, naming and verification stages have run 254
   businesses with **zero** pipeline failures.

---

## 9. Commit history

| Commit | What |
|---|---|
| `ec90d34` | Baseline: v1 as-is + ARCHITECTURE/MIGRATION |
| `fc1614a` | Phase 1: worker fleet infrastructure |
| `ec1eb59` | Config injection, single egress dispatcher, metrics/migration fixes |
| `00e0625` | verify-svc: pin SMTP dial to bound address family |
| `878319f` | Deploy fleet to srv607166; drop pgbouncer from default path |
| `cb05344` | ProxyPool: Decodo's real sticky-session and geo-targeting model |
| `37bed01` | Phase 2: Maps → crawl → enrich → verify on the queue |
| `c6c7155` | Field notes: v1/v2 race, gosom defects |
| `a913088` | verify-svc: pacing, stop-at-first-safe, policy-5xx |
| `b730e24` | Handoff for Phase 2 |
| `78d760f` | verify-svc: `/debug/dial`, restricted to private callers |
| `a07abd6` | Port 25 root cause established by three methods |
| `99c03cf` | UTC packet-capture evidence for the Hostinger ticket |
| `e20b5e6` | Close verify-svc :8080 to the internet |
| `ab6f24d` | Verifier hardening: dial failures count, budgets bind, alerts |
| `354bf94` | verify-svc: count each dial once |
| `0a9e0a8` | maps: wait for a non-empty download |
| `0cddfa5` | maps: auth-forwarding proxy + hard exit-IP guard |
| `bb6a729` | maps: revert to credentialed URLs — gosom runs its own auth proxy |
| `9869a30` | Pre-Phase-3: gosom stability, reject label, Long Island membership |

---

## 10. Judgement notes for whoever continues

The standing rule on this project is **two independent measurements that agree
before acting on a diagnosis**, and when a tool reports total failure, check the
tool before believing it. It has paid for itself repeatedly.

Four root-cause calls were wrong in earlier phases and were corrected only
because a second measurement disagreed: "PTR forward-confirmed" (one resolver's
view as global fact), "Verifalia egress problem" (it was HTTP 402), "Google
penalty box" (the same failure hit non-Google MXs), and a nearly-published
"Hostinger blocked port 25" taken from a probe script that mis-scored every
attempt. That last one was ultimately *correct* — but the evidence it rested on
was worthless, and being accidentally right is not the same as knowing.

This phase added four more of the same shape, all caught by measuring first:

- **`decodo-proxy`** was built to solve an auth problem gosom had already solved
  internally. The `[AuthProxy]` lines were in its own logs the whole time. Cost:
  one dead discovery run.
- **`gbp_owner`** was specified as a name source; the field is 0/100
  person-shaped. Measuring took ten minutes and saved building a source worth
  nothing.
- **The crawl "coverage bug"** was not a crawl bug at all — coverage is fine and
  the title gate is the wall.
- **"57/75 on Long Island"** was my own measurement artefact. The data was
  75/75. A number you produced yourself deserves the same scepticism as one a
  tool hands you.

The pattern worth carrying: when a task is phrased as "fix X", confirm X is
broken before fixing it. Three of this phase's four items dissolved on contact
with data, and the one real fix (§6.3) was smaller than the audits that found it.
