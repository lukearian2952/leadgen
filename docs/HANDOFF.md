# LeadGen v2 — Handoff (Phase 3)

State as of 2026-08-17. Written so someone else (or me, later) can pick this up
without re-deriving anything. `ARCHITECTURE.md` is the design, `MIGRATION.md`
the v1→v2 plan; this file is *what is actually true right now*.

**One-line status:** Phase 2 is complete and proven end to end. A clean
100-business campaign ran the full queue and produced a small but real result:
75 businesses, 18 named, 1 Tier A, for about 68¢. Cost and verification are
solved. **Names are the wall**, and the pre-Phase-3 audits established precisely
why — which changes what Phase 3 should build.

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
