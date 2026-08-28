# OPERATIONS

How to run LeadGen v2. Written for whoever operates it next, including a future
session with no memory of building it.

| document | answers |
|---|---|
| **OPERATIONS.md** (this) | how do I run it |
| `RUNBOOK.md` | it broke, what now |
| `HANDOFF.md` | what is true right now, and why |
| `REPORTS/final-build-report.md` | what it yields and what that cost |

**Two things to know before touching anything.**

The server also runs unrelated production workloads — Odoo ×2, n8n ×2,
narrative-radar, three Postgres, nginx. Ports 22/80/443/3000/5432/5678/5679/
8069/8070/9120/9209 are theirs. Every LeadGen service binds `127.0.0.1` except
`verify-svc`, which is firewalled.

`/opt/leadgen` is an **rsync target, not a git checkout**. Never edit code on
the server; the next deploy silently reverts it.

---

## 1. Run a campaign, start to finish

### 1.1 Before you start

```bash
# Verification credits. Without these NOTHING reaches Tier A — every candidate
# parks unverified and the campaign looks like a dead niche.
curl -s -u "$VERIFALIA_USERNAME:$VERIFALIA_PASSWORD" \
  https://api.verifalia.com/v2.6/credits/balance
```

**Budget ~6 credits per named lead.** The pattern ladder verifies six candidate
addresses per person. A 1,000-business run at a 25% naming rate is ~1,500
credits. Check first — a run that exhausts credits partway produces rows that
are indistinguishable from undeliverable ones at a glance, and that mistake has
already cost this project two reports.

```bash
# v1's pg_cron watchdog must stay unscheduled. Must return 0.
psql "$DATABASE_URL" -c "select count(*) from cron.job"

# Queue idle, fleet healthy
ssh root@92.112.184.200 'cd /opt/leadgen && docker compose ps'
```

### 1.2 Start it

From the UI (**New Campaign**), or by hand on the server:

```bash
cd /opt/leadgen/workers
npx tsx scripts/niche-campaign.ts start "med spa" "Long Island NY" 100
npx tsx scripts/saas-campaign.ts  start "crm software" "United States" 100
```

The UI's Start button calls the `start_campaign_v2` RPC, which picks
`maps:discover` or `saas:discover` from the niche — brick-and-mortar niches
match a rule in `niche-types.ts`, and anything unmatched is treated as online.

**Residential budget defaults to 2.5 GB per campaign.** The 1,000-business
national run spent 1.53 GB of it, so that is a real ceiling, not a formality.

### 1.3 What happens, and how long

```
maps:discover ──┐
                ├─▶ crawl:site ─▶ registry:match ─▶ [serp:owner] ─▶ enrich:lead
saas:discover ──┘   (name+email)   (name, both        (name, only     (mailbox,
                                    directions)        when it helps)  verify, tier)
                                                                            │
                                                  campaign:reconcile ◀──────┘
```

| stage | pace |
|---|---|
| `maps:discover` | 36 queries per batch, each enqueuing its successor. 20–45 min per batch |
| `crawl:site` | ~6 pages per business, datacenter first, residential only on a block |
| `registry:match` | fast; decides whether SERP is worth buying |
| `serp:owner` | **online niches only**, and paced at 16.7 s/query — about 50 s per lead |
| `enrich:lead` | ~6 verification checks per named lead |

A 1,000-business Maps campaign is **~1.75 h**. A 150-business SaaS campaign is
**~20 min** unless SERP runs, which paces it — see §5.

### 1.4 Watch it

**Campaign detail page** — the live funnel, tier counts, log, and the alert
banner. This is the screen to watch.

```bash
# Or from the server
docker compose logs -f enrich-worker
psql "$DATABASE_URL" -c "
  select stage, status, count(*), round(sum(cost_cents)::numeric,1) cents
    from job_runs where campaign_id = '<id>' group by 1,2 order by 1"
```

### 1.5 When it finishes

Status goes `completed`, or **`completed_low_yield`** if under 25% of scraped
businesses produced a mailable owner. **`completed_low_yield` is a success
state** — the run worked, the niche is thin. The UI shows it amber with a "do
not upload this list" warning, and that warning is meant literally.

**Check the alert banner before exporting.** In particular
`tiered_rows_unverified` (§6) means the yield figures are not trustworthy yet.

### 1.6 Export

`campaign-export` writes two CSVs as 1-hour signed URLs: gate-passing rows, and
a `-rejected.csv` carrying `reject_reason`.

**Tier A and Tier B are not the same list.** Tier B is sendable with a caveat —
a named owner on a catch-all domain, or an owner-named freemail address. There
is no proof that specific mailbox exists. Segment it away from Tier A in any
send; merging them is how you get a bounce rate.

`exports/` is gitignored, holds customer records, and **is backed up nowhere**.
Treat a CSV there as the only copy.

---

## 2. The dashboards

### 2.1 Campaign list — `/`
Every campaign, status, and yield. The **preflight census** number shows here:
what share of businesses in a niche publish a personal address on their own
site. It is a comparison *between niches*, not a prediction — the predictive
band was dropped because it returned the same answer for all five niches
measured. Treat a high census as "worth trying before the others", nothing more.

### 2.2 Campaign detail — `/campaign/:id`
The funnel, per-tier counts, the live log, and **the alert banner** (§6). Leads
stream in over Realtime; no refresh needed.

### 2.3 Worker health — `:9100/healthz` and `:9100/metrics`
Every worker serves both on `METRICS_PORT`, loopback only. `/metrics` is
Prometheus-style: job counts by stage and status, durations, costs, dead
letters. Nothing scrapes it yet — `curl` it, or point Prometheus at it.

```bash
ssh root@92.112.184.200 'cd /opt/leadgen && docker compose ps'   # the fastest check
```

---

## 3. Weekly registry refresh

**Sunday 03:00 UTC, automatic**, from the crontab baked into the worker image.
`registry:refresh` re-ingests whatever slice each state already holds, reading
the scope back out of `registry_ingest_runs` — including the `whole_state` flag
and FL's `quarterly` mode, without which Florida would silently be re-ingested
as five days of filings instead of the whole state.

States are staggered 20 minutes apart, so the cycle is under two hours and never
has two ingests writing at once.

```bash
# What is loaded, and under what scope
docker exec leadgen-registry-db-1 psql -U registry -d registry -c \
  "select state, whole_state, mode, written, complete, finished_at
     from registry_ingest_runs order by state"

# Did last Sunday run?
docker compose logs --since 8d registry-worker | grep 'registry ingest complete'
```

Current coverage: **FL 11.0M (whole)**, **NY 1.5M (whole)**, CO 30k, OR 7k, CT
5k (niche-scoped). registry-db is **9.9 GB against a 20 GB ceiling** — the three
scoped states are small, but a third whole-state load the size of Florida would
not fit.

**The Socrata route is exhausted.** A network-wide catalog search returns
exactly those four Socrata registries with person names; the rest are paid-only
or bot-walled. Do not go looking again without new information.

To load a state whole, or re-scope one:

```bash
./run.sh scripts/registry-enqueue.ts CO --whole
./run.sh scripts/registry-enqueue.ts FL --whole quarterly   # FL needs quarterly
```

---

## 4. Backups and restore

**registry-db** is dumped nightly at **03:20 UTC** to `/opt/leadgen/backups`,
seven kept, `pg_dump --format=custom`.

```bash
./infra/registry-db/backup.sh          # manual dump; prunes to KEEP=7
./infra/registry-db/restore-test.sh    # scratch container, verifies, self-deletes
tail /opt/leadgen/backups/backup.log   # what cron did
```

**A real restore:**

```bash
docker compose stop registry-worker
pg_restore -U registry -d registry --no-owner --clean \
  /opt/leadgen/backups/<dump>
docker exec leadgen-registry-db-1 psql -U registry -d registry -c \
  "analyze registry_entities"          # do not skip: the planner needs it
docker compose start registry-worker
```

Restore-tested 2026-08-27 — all rows, all seven indexes, and a live trigram
match against the restored copy. **Run `restore-test.sh` occasionally; an
untested backup is a hope.**

The volume survives a container rebuild but **not `docker compose down -v`**.

**Everything else:** Supabase has its own backups (limited on the free plan —
check before relying on them). Code lives in the Mac's git repo and nowhere
else. `exports/` is backed up nowhere.

---

## 5. SERP pacing — do not "fix" this

`serp:owner` runs at **one query per 16.7 seconds**, process-wide. It looks
broken. It is not.

`site:linkedin.com/in` is honoured by exactly one of the upstreams SearXNG
aggregates. Bing discards the operator silently and answers with the company's
own domain; the engine that honours it answers **about nine queries and then
suspends itself for two minutes**. The failure is invisible — SearXNG still
returns `200` with a `results` array, just one assembled from the engine that
ignored half the query.

The same experiment scored **1/89 unpaced and 15/93 paced**, on identical code
and identical queries.

**Any SERP number taken from a burst run is not a measurement.** Check the
engine mix before believing one:

```sql
select r->>'engine', count(*),
       count(*) filter (where r->>'url' like '%linkedin.com/in%') linkedin
  from serp_cache c, jsonb_array_elements(c.results) r
 where c.fetched_at > now() - interval '2 hours' group by 1;
```

Raising the pacing requires a *different provider*, not a bigger number.
`SERPER_API_KEY` switches to Serper and removes the limit; it is the only paid
SERP option and is inert without the key. Google's own paid API would need
Custom Search JSON API enabled on the project and a new provider — the current
`google cse` engine is a keyless scrape and no key affects it.

---

## 6. Alerts — what each one means

Alerts appear on the campaign detail page and clear when acknowledged. They
exist because a verifier that cannot run is otherwise invisible: the run looks
like it worked and produces nothing.

| alert | means | do |
|---|---|---|
| **Verifalia is out of credits** (`verifalia_payment_required`) | HTTP 402. **There is no fallback** — port 25 is blocked upstream, so verify-svc cannot cover an outage | Top up, then re-run `enrich:lead` for affected leads. Everything since the alert is unverified, not undeliverable |
| **Verifalia rejected our credentials** (`verifalia_unauthorized`) | HTTP 401 | Fix `VERIFALIA_USERNAME` / `VERIFALIA_PASSWORD`, re-run affected leads |
| **Some leads were tiered without being verified** (`tiered_rows_unverified`) | Leads reached Tier A/B/C with **zero verification checks** — assumed, not judged | **The yield figures are not trustworthy.** Re-run `enrich:lead` for the campaign before exporting or quoting it |
| **All verification IPs are cooling** (`verifier_all_ips_cooling`) | verify-svc's IPs are rate-limited by the far end | Wait. Repeated firing means the send reputation needs attention |
| **No verifier is available** (`no_verifier_available`) | Nothing can verify at all | Nothing will reach Tier A until it is fixed. Stop and fix |

`tiered_rows_unverified` is the one that was added last and the one that found
the most. **10% of Tier C had never been verified**; re-running those rows
converted half of them to sendable. A tiered row with zero verification checks
is a bug, not a result.

**A warning nobody acts on is worse than no warning.** If an alert becomes
routine, either fix the cause or delete the alert.

---

## 7. Routine checks

**Weekly** (a Monday summary is written to `docs/REPORTS/weekly/` — §8):

```bash
docker compose ps                                   # 13 up
psql "$DATABASE_URL" -c "select count(*) from cron.job"          # 0
psql "$DATABASE_URL" -c "select count(*) from dead_letter
  where requeued_at is null and resolution is null"              # outstanding only
curl -s -u "$VERIFALIA_USERNAME:$VERIFALIA_PASSWORD" \
  https://api.verifalia.com/v2.6/credits/balance
df -h /                                             # registry-db grows
```

**Scope every run-health query by time.** A monitor counting all-time
`status='failed'` reports stale failures forever.

**Never restart a worker while `maps:discover` is in flight** — graphile holds
the lock for four hours and the residential bytes are already spent.

**After any shared-code change, `docker compose build` with no service argument.**
Each worker builds its own image; a partial build leaves older images running
with no indication.

---

## 8. The weekly summary

`scripts/weekly-report.ts` runs **Monday 08:00 UTC** and writes a dated markdown
file to `docs/REPORTS/weekly/`. It reports inventory by niche, spend, campaign
activity, fleet and queue health, registry coverage, outstanding dead letters,
open alerts, and the Verifalia balance — and it flags anything that needs a
human.

```bash
./run.sh scripts/weekly-report.ts                  # run it now
./run.sh scripts/weekly-report.ts --stdout         # print instead of writing
```

It is written to be read cold. If something in it is unclear a week later, fix
the report rather than remembering the explanation.
