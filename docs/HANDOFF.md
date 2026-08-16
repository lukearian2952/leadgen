# LeadGen v2 — Handoff

State as of 2026-08-16. Written so someone else (or me, later) can pick this up
without re-deriving anything. Read `ARCHITECTURE.md` for the design and
`MIGRATION.md` for the v1→v2 plan; this file is *what is actually true right
now*.

**One-line status:** Phases 0 and 1 are complete and proven. Phase 2 is built
and deployed but has **never produced a valid dataset** — zero Tier A rows —
because of an unresolved port-25 intermittency and an out-of-credit Verifalia
account. Do not trust any funnel number produced so far.

---

## 1. Stack state

### Server
`srv607166` / `92.112.184.200`, Ubuntu 24.04.3, 4 cores, 15 GB RAM, ~96 GB free.
Deployed at `/opt/leadgen` (rsynced from the Mac; not a git checkout).

**The box also runs unrelated production workloads** — Odoo ×2, n8n ×2,
narrative-radar, 3 Postgres, 1 Redis. Ports 22/80/443/3000/5432/5678/5679/8069/
8070/9120/9209 are theirs. Every LeadGen service has an explicit `mem_limit` so
a crawl spike cannot starve them.

### Containers (all healthy at last check)

| Service | Port | mem_limit | Notes |
|---|---|---|---|
| verify-svc | :8080 | 256m | `network_mode: host` — required to bind `VERIFY_IPS` |
| searxng | 127.0.0.1:8888 | 512m | JSON API works, returns real results |
| crawl4ai | 127.0.0.1:11235 | 2g | up; **not yet used by any job** |
| maps-scraper | 127.0.0.1:8085 | 512m | gosom; scrapes correctly, results not retrievable (§5.3) |
| maps-worker | 127.0.0.1:9101 | 512m | |
| crawl-worker | (scaled) | 512m | |
| enrich-worker | 127.0.0.1:9106 | 512m | |
| verify-worker | 127.0.0.1:9107 | 512m | |
| scheduler | 127.0.0.1:9108 | 512m | `campaign:reconcile`, singleton — never scale |

Default profile totals **5.75 GB** against a 7 GB budget. `--profile full` adds
serp/linkedin/registry workers + standalone Playwright = 9.25 GB, **over
budget**. Actual usage when idle is ~234 MiB.

`docker compose up -d` from `/opt/leadgen`. Each worker builds its own image, so
`docker compose build` (no service arg) is needed after a code change or older
images silently keep running.

### Database
Supabase project `paasggeawsoctfgqbqrd` ("Lead Generation"), Postgres 17.

Migrations applied through `20260816000004`:
- `20260816000003_worker_queue` — `job_runs`, `dead_letter`, `source_costs`,
  `verifier_ip_state`, `pg_trgm`, RLS, Realtime
- `20260816000004_phase2_entities` — `businesses`, `people`, `contacts`,
  `domain_patterns`, `tech_stack`, `serp_cache`, plus
  `leads.tier/score/sources/evidence/county/category/crawl_done/enrich_done`

`graphile_worker` schema is installed by the library at worker boot.

**v1's pg_cron watchdog has been unscheduled** (`cron.unschedule('campaign-watchdog')`,
0 cron jobs remain). It must stay off — see §5.1. Reversible by re-running the
`cron.schedule` block in `20260803000001`.

### Connection budget — important
Supavisor allows **~15 session-mode clients project-wide**. graphile-worker
needs session mode for `LISTEN/NOTIFY`. Each worker is capped at
`maxPoolSize: 2`; application queries use the transaction pooler (`:6543`);
the boot assertion uses one short-lived client. Six workers ≈ 12 session slots.
**Adding worker replicas will exhaust this** and the new container will
crash-loop on `EMAXCONNSESSION`.

`db.<ref>.supabase.co` is **AAAA-only** — Supabase dropped IPv4 for direct
connections. Both URLs must use the pooler hostname.

---

## 2. Environment variables — where each lives

| File | Location | Committed? | Contents |
|---|---|---|---|
| `.env` | Mac repo root **and** `/opt/leadgen/.env` | No (gitignored) | Everything the fleet reads |
| `.env.local` | Mac only | No (gitignored) | `SUPABASE_ACCESS_TOKEN`, `VITE_SUPABASE_*` |
| `.env.example` | repo | **Yes** | Template + rationale for every var |
| `docs/ENV.md` | repo | **Yes** | Table: name / required? / where to get it / which worker reads it |

`workers/src/config.ts` is the source of truth — it declares the full list and
refuses to boot when a required var is missing, printing all of them at once.
`workers/test/config.test.ts` asserts the list stays in sync.

**`.env` values must be double-quoted when they contain shell metacharacters.**
Three passwords contain `(`, `)` or `'`; unquoted they silently abort
`set -a; . ./.env` partway, so every variable after `VPS_PASSWORD` goes missing.
Double quotes are the one form both bash and Compose accept — bash-style `'\''`
escaping breaks `docker compose config` entirely.

### Currently set
Core: `DATABASE_URL` (:6543 txn), `DATABASE_URL_DIRECT` (:5432 session),
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_*`, `FORCE_IPV4=true`.
LLM: `ANTHROPIC_API_KEY`.
Proxy: `DECODO_USERNAME/PASSWORD/HOST`, `DECODO_PORT=7000` (rotating),
`DECODO_COUNTRY=us`, `DECODO_STICKY_PORT_MIN=10001`/`MAX=10100`,
`DECODO_STICKY_TTL=600`.
Services: `SEARXNG_URL`, `CRAWL4AI_URL`, `GOOGLE_MAPS_SCRAPER_URL`,
`SEARXNG_SECRET`, `GOOGLE_PLACES_API_KEY` (fallback only).
Verify: `VERIFY_URL`, `VERIFY_IPS=92.112.184.200`,
`VERIFY_HELO_DOMAIN=verify1.bezbuilder.com`,
`VERIFY_FROM_EMAIL=verify@bezbuilder.com`, `VERIFIER=hybrid`,
`VERIFALIA_USERNAME/PASSWORD`, `VERIFALIA_MAX_CENTS_PER_CAMPAIGN=500`.
Runtime: `WORKER_ROLE` (per container), `WORKER_CONCURRENCY=5`, `LOG_LEVEL`,
`METRICS_PORT=9100`.

Not set: `SOCRATA_APP_TOKEN`, `LINKEDIN_ACCOUNTS` (both optional, degrade loudly).

### Credential hygiene
- `SUPABASE_ACCESS_TOKEN` was pasted into a chat transcript and **should be
  rotated**: dashboard → Account → Tokens, then replace the value in
  `.env.local`. Only the CLI on the Mac reads it; rotating won't disturb the stack.
- The v1 `.env` keys were in an unignored file before `git init`. `APIFY_API_KEY`
  should be revoked (Apify is gone); `OPENAI_API_KEY`, `GEONIX_API_KEY`,
  `TELEGRAM_*`, `VPS_SCRAPER_*`, `GOOGLE_CSE_*` are read by no code and should be
  revoked rather than rotated.

### DNS / deliverability
PTR `92.112.184.200 → verify1.bezbuilder.com` and A back to the IP
(forward-confirmed) as seen from the Mac's resolver. **Propagation is uneven** —
the VPS's Google anycast node still served the old `srv607166.hstgr.cloud` at
last check. SPF on `bezbuilder.com` authorises the IP. `verify1.bezbuilder.com`
has no SPF TXT of its own; some receivers check SPF on the HELO identity, so
`v=spf1 a -all` there would close that gap.

---

## 3. Built and tested

**67/67 Vitest tests pass; `tsc --noEmit` clean.** `cd workers && npm test`.

| Area | Tests | Proven behaviour |
|---|---|---|
| `verify/cooldown.ts` | 16 | 24h cooldown, hourly caps (150 Google/MS, 400 else), round-robin, forced-421 reroute, `allCooling` vs `allAtCap`, auto-recovery. Correctly does **not** cool on a plain 550. |
| `verify/hybrid.ts` | 8 | The four routing rules, budget cap, risky-before-unknown priority, agreement counting |
| `verify/types.ts` | 9 | Tier A/B/C/rejected assignment, score weights |
| `lib/patterns.ts` | 15 | Pattern inference, one-candidate collapse, no-flip-on-single-disagreement |
| `config.ts` | 12 | Fail-fast lists all missing vars, per-role requirements, `LINKEDIN_ACCOUNTS` colon handling |
| `proxy/pool.ts` | 7 | Sticky port mapping, determinism, range safety |

**Proven live (not by unit test):**
- graphile queue round-trip: ping job consumed in 65 ms, `job_runs` written
- `LISTEN/NOTIFY` over the Supavisor session pooler
- Decodo: rotating gives 3 distinct US residential IPs; sticky key → stable
  port → stable IP; different key → different port/IP
- SearXNG JSON API returns real results, surfaced an owner name in the top 5
- verify-svc against real MX: `250 accepted` for a live mailbox,
  `550 5.1.1 ... does not exist` for a fake one, correct catch-all detection,
  null-MX short-circuit
- Naming stage: 50/100 leads named, **100% of them owner-titled** (Co-Founder,
  CEO, Medical Director …), zero generic staff names

---

## 4. Implemented but UNPROVEN

Treat everything here as suspect.

| Thing | Where | Why unproven |
|---|---|---|
| **stop-at-first-safe** | `prober.go`, commit `a913088` | **No test.** The brief required it; the original code probed all six candidates, which doubled connection count. Logic is written but never asserted. A test should prove a lead whose first candidate is `safe` makes exactly one RCPT probe. |
| Per-MX connection pacing (12 s) | `prober.go` | Did not measurably help — the re-run produced the same 26 timeouts. Unclear whether it works and the problem is elsewhere, or it does not work. |
| Policy-5xx reclassification | `prober.go` `policyReject` | Verified by inspection only. Should assert that `550 Please turn on SMTP Authentication` → `unknown`, and `550 5.1.1 does not exist` → `invalid`. |
| `Transient` flag | `prober.go` | Emitted by Go but **nothing consumes it**. `enrich-lead.ts` still finalises transient failures as rejected instead of scheduling a retry. The brief requires "unknown + retry after 15 min". |
| `campaign:reconcile` | `jobs/reconcile.ts` | Ran 9 times without error, but never exercised against a genuinely stalled fan-out. |
| crawl4ai | container up | **No job calls it.** `crawl.ts` uses direct fetch with residential escalation; crawl4ai is the intended fallback for JS-rendered pages and is unwired. |
| `contacts` / `businesses` / `people` | migration + writes | `businesses` and `contacts` are written; `people` is never populated. Dedupe indexes untested under collision. |

---

## 5. Open problems

### 5.1 — v1 raced v2 (fixed, must stay fixed)
v1's `campaign-watchdog` pg_cron job was still active and scraped 100
businesses through the **Google Places API** into the same `leads` table while
v2 was running. v1's AI location expansion turned "Long Island, NY" into New
York and Brooklyn, so those rows are the wrong region *and* the wrong
provenance. They are identifiable by empty `sources`/`evidence` — every v2
writer populates both.

Estimated accidental Places spend: ~30 Text Search + ~100 Place Details at v1's
own rate table = **≈ $3.46**. Confirm in Cloud Console → Billing.

Any process that sets a campaign to `status='running'` would have retriggered
this. The cron is now unscheduled; verify with `select count(*) from cron.job`
before every run.

### 5.2 — Port 25 (**RESOLVED 2026-08-16: outbound TCP/25 is dropped upstream**)

**Root cause: every outbound TCP/25 packet from `92.112.184.200` is silently
discarded beyond our NIC, on both address families.** It is not intermittent,
not Google, not Docker, not IPv6, and not the prober. A small number of
connections succeed after a long idle and everything after them is dropped —
which is what made it look intermittent.

Established by three independent methods that agree:

1. **Shell probes** (`nc -4/-6`, exit status captured per attempt, validated
   against known-open and known-unreachable targets first). Concurrency 1:
   Google 2/13, Outlook 2/12, improvmx 1/12 — and *every* success falls in the
   first four seconds, followed by 33 consecutive failures. A 40-round control
   ran alongside: `1.1.1.1:443` scored **40/40** while `MX:25` scored **0/40**
   over 17.5 minutes.
2. **Packet capture on `eth0`.** SYNs leave the interface with the correct
   source address and are retransmitted seven times; **nothing returns** — no
   SYN-ACK, no RST, no ICMP. A 443 control on the same NIC completes its
   handshake in 5 ms. Packets leave the box and die upstream, so nothing local
   is responsible.
3. **`GET /debug/dial`** — the prober's own dialler, same `LocalAddr` binding and
   family pinning: `0/5` to Google over tcp4, `0/5` over tcp6, `0/20` to
   Outlook, all `i/o timeout`.

**Port-specific, not host-specific.** On `mx1.improvmx.com` at one instant:
`:587` → 81 ms, `:465` → 85 ms, `:25` → timeout. **Provider-independent:**
Google, Microsoft and improvmx (AWS) fail identically and simultaneously, which
no single mailbox provider could coordinate.

**Both families are affected.** IPv6 :25 worked for ~26 connections (Google even
returned a full banner and `250-mx.google.com at your service,
[2a02:4780:2d:e3fc::1]`) and then failed continuously from 22:32 onward. IPv6 is
therefore **not** a workaround — it hits the same limiter, and the v6 address has
neither PTR nor SPF.

This corrects three claims previously recorded here: measurement #9's confound
was *not* broken IPv6 (v6 egress is healthy — `ping6` 0% loss, `curl -6` 200 in
117 ms); the prober's tcp4 pinning was never the issue; and "Hostinger blocking
25", rejected in the old *Ruled out* list on the grounds that "connections do
succeed, just unreliably", was right after all — the successes are a burst
allowance, not evidence of an open path.

**Blocked on Hostinger lifting the block.** No concurrency setting helps: the
measured sustainable rate is zero, so there is no safe rate to throttle down to.

---

#### Historical: the measurements taken before the cause was known

Kept because the validity notes are the useful part.

| # | Measurement | Result | Valid? |
|---|---|---|---|
| 1 | Host shell, 4 MX hosts, `/dev/tcp` | all OPEN; full SMTP to Gmail + Outlook | ✅ valid |
| 2 | IPv4-pinned bound probe from host | Gmail sees `92.112.184.200`; `250` real / `550 5.1.1` fake | ✅ valid |
| 3 | verify-svc, 3-address batch | perfect — `250`, `550 5.1.1`, catch-all | ✅ valid |
| 4 | Campaign run, 318 checks | 293 `unknown`, 5 safe, 12 invalid, 8 risky | ✅ valid |
| 5 | 38-candidate batch, before pacing fix | 26 `CONNECT_FAIL` (`dial … i/o timeout`), 5×550, 4 catch-all, 1×250 | ✅ valid |
| 6 | 38-candidate batch, after pacing fix | 26 `CONNECT_FAIL`, 6 catch-all, 2×550, 2×250 | ✅ valid |
| 7 | 3×3 transport matrix (`nc -4 -z` ×20) | `0/20` everywhere | ❌ **INVALID** |
| 8 | `nc -4 -z` run interactively | **succeeded**, exit 0 | ✅ valid |
| 9 | `/dev/tcp` ×10 | Gmail 3/10, Outlook 4/10, improvmx **0/10** | ⚠️ confounded |

**Why #7 is invalid:** the `p25()` helper in `matrix.sh` failed to capture nc's
exit status, so every attempt scored as a failure. The same command run by hand
succeeds. **I nearly reported "Hostinger has blocked port 25" on the strength of
this table.** Do not reuse that script.

**Why #9 is confounded:** bash `/dev/tcp` has no address-family control and
prefers IPv6. This host's IPv6 is broken (the reason `FORCE_IPV4=true` exists) —
`nc` without `-4` resolved improvmx to IPv6 and `nc -4` to IPv4, and only the
latter connected. So #9 is partly measuring the dead v6 route, not port 25.

**Ruled out:**
- *Google throttling* — Outlook and improvmx behave the same; Google cannot
  throttle improvmx. An earlier "Google penalty box" conclusion was unsupported.
- ~~*Hostinger blocking 25* — connections do succeed, just unreliably.~~
  **This dismissal was wrong; see the resolution above.**
- *Docker networking* — 443 works from host, bridge container and host-mode
  container alike.
- *Local firewall* — `iptables OUTPUT policy ACCEPT`, nft empty of relevant
  rules, ufw inactive. Re-confirmed by packet capture: the SYNs do leave `eth0`.

Also ruled out during the 2026-08-16 diagnosis: conntrack pressure
(101 / 262144 in use, no dmesg events), MTU (1500 uniform, no PMTU blackhole),
ephemeral-port or TIME_WAIT exhaustion (0 sockets in TIME_WAIT to :25), and
resolver behaviour (systemd-resolved via 1.1.1.1; AAAA-first ordering is real
but irrelevant, since both families are dropped).

### 5.3 — gosom results unreachable
Two defects. The scraper demonstrably retrieves the right businesses (Nu Med,
Brizel, Deep Blue in Garden City), but:
1. Job status flips to `ok` while scraping continues, and `/download` returns
   **0 bytes** — still 0 fifteen minutes later. `MapsSource.waitFor` trusts the
   status and reports `returned: 0`. Polling must additionally require a
   non-empty download, with a hard cap.
2. Playwright inside the scraper cannot authenticate to Decodo: **498**
   occurrences of `ERR_PROXY_AUTH_UNSUPPORTED` / `Upstream proxy rejected
   CONNECT: 522`. Chromium does not accept credentials embedded in a
   `--proxy-server` URL; it needs a local auth-forwarding proxy.

### 5.4 — Verifalia HTTP 402
The account is **out of credits**. Transport is fine: from the bridge-networked
worker, `httpFetch → 401` unauthenticated, **`200`** for a single authenticated
address, `clientIP: 92.112.184.200` (confirming it does not route via the proxy
pool), `FORCE_IPV4` and the `net.ts` dispatcher both confirmed applied at
runtime. A 38-address submit returns `402 Payment Required`.

The code handles it correctly — logs, returns `unknown`, spends nothing,
fabricates no verdicts — but it degrades **silently**. A 402 removes the entire
safety net and should raise an alert.

**Consequence: the hybrid fallback is currently non-functional.** Even once
cooldown detection is fixed there is nothing to fall back to.

### 5.5 — Dial timeouts don't trigger cooldown
`IsBlockResponse` looks for SMTP codes; `i/o timeout` carries none. So the fleet
keeps probing a failing IP instead of cooling it and routing to Verifalia —
precisely the mechanism that should have rescued the run.

---

## 6. Next steps, in order

1. **Rewrite the transport probe correctly** — `nc -4`, exit status captured,
   IPv4 forced. Re-run the 3×3 matrix. The current table is worthless.
2. **Instrument the Go prober per dial**: resolved IP, address family, outcome,
   elapsed. We need what *it* experiences, not a shell approximation. This is
   the shortest path to the port-25 root cause.
3. **Top up Verifalia.** Without it there is no fallback and no second opinion,
   so no way to distinguish "our verifier is broken" from "the mailbox is bad".
4. **Verifier hardening** (all currently missing):
   a. dial timeout / refused counts toward cooldown — 3 consecutive to one MX →
      30 min backoff for that MX+IP; 10 within 5 min across MXs → IP `cooling`
      and route to Verifalia. Log both.
   b. enforce ≤150 checks/h/IP toward Google+Microsoft, ≤400/h elsewhere,
      1 concurrent connection per MX, ≤4 concurrent port-25 connections per IP.
      Prove with a unit test and expose live counters on `/metrics`.
   c. test that stop-at-first-safe makes exactly one RCPT probe.
   d. consume the `Transient` flag in `enrich-lead.ts` — retry after 15 min
      instead of finalising as rejected.
5. **Recovery probe**: `postmaster@gmail.com` from verify-svc every 30 min into
   a table, so intermittency is visible over time rather than sampled.
6. **gosom**: polling waits for a non-empty download, treats "ok + 0 bytes" as
   still-running, 20 min hard cap.
7. **Auth-forwarding proxy container** for Playwright → Decodo; log its exit IP
   per session to prove US targeting still holds.
8. **Confirm before running**: `select count(*) from cron.job` = 0, and no
   Places API calls during the run.
9. **Then** a clean campaign: "med spa" / "Long Island, NY", 100 businesses,
   end to end.

Do not run step 9 before 1–4. Another run against a throttled verifier with no
fallback will produce another zero and cost proxy GB to learn nothing.

---

## 7. Commit history

| Commit | What |
|---|---|
| `ec90d34` | Baseline: v1 as-is + ARCHITECTURE/MIGRATION |
| `fc1614a` | Phase 1: worker fleet infrastructure |
| `ec1eb59` | Config injection fix, single egress dispatcher, metrics/migration fixes |
| `00e0625` | verify-svc: pin SMTP dial to bound address family |
| `878319f` | Deploy fleet to srv607166; drop pgbouncer from default path |
| `cb05344` | ProxyPool: Decodo's real sticky-session and geo-targeting model |
| `37bed01` | Phase 2: Maps → crawl → enrich → verify on the queue |
| `c6c7155` | Field notes: v1/v2 race, gosom defects |
| `a913088` | verify-svc: pacing, stop-at-first-safe, policy-5xx |

---

## 8. Judgement notes for whoever continues

Three root-cause calls in this project were wrong and were corrected only
because a second measurement disagreed with the first:

- "PTR forward-confirmed" — one resolver's view reported as global fact.
- "Verifalia egress problem" — it was HTTP 402, out of credits.
- "Google penalty box" — unsupported; the same failure hit non-Google MXs.

And a fourth was nearly published: "Hostinger blocked port 25", from a probe
script that mis-scored every attempt.

The pattern is concluding from a single measurement. For anything in §5, get two
independent measurements that agree before acting on a diagnosis — and when a
tool reports total failure, check the tool before believing it.
