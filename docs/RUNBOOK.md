# RUNBOOK

What to do when something is wrong, and how to do the routine things safely.

`ARCHITECTURE.md` is the design, `HANDOFF.md` is the current state,
`DECISIONS.md` is why things are the way they are. **This file is for the
person on the keyboard at the time.**

Read §0 before touching anything.

---

## 0. The five things that will bite you

These are not hypothetical. Each one cost real hours.

1. **This box runs unrelated production workloads.** Odoo ×2, n8n ×2,
   narrative-radar, 3 Postgres, 1 Redis, nginx. Ports 22/80/443/3000/5432/5678/
   5679/8069/8070/9120/9209 are theirs. `docker compose down` in the wrong
   directory takes out someone's ERP.

2. **Never restart a worker while `maps:discover` is in flight.** graphile holds
   the job lock and its expiry is **4 hours**. `releaseStaleLocks` at boot
   mitigates it, but a restart still abandons a running scrape and the bytes are
   already spent.

3. **The connection budget is a hard ceiling.** Supavisor allows ~15 session-mode
   clients project-wide; each worker holds 2. **Seven workers ≈ 14 is the
   ceiling.** An eighth crash-loops on `EMAXCONNSESSION` — and so does your
   ad-hoc `psql` while seven are up. Scripts use `DATABASE_URL` (transaction
   pooler, :6543) and `graphile_worker.add_job` in SQL for exactly this reason.

4. **`.env` values containing shell metacharacters must be double-quoted.**
   Three passwords contain `(`, `)` or `'`. Unquoted, `set -a; . ./.env` aborts
   partway and *every variable after `VPS_PASSWORD` goes missing* — silently.
   After any `.env` edit, check that the **last** variable still reads.

5. **A tool reporting total failure is usually lying.** The standing rule on this
   project is **two independent measurements that agree before acting on a
   diagnosis**. Every retracted root cause in `HANDOFF.md` §11 was a case of
   skipping it.

---

## 1. Where everything is

| | |
|---|---|
| Server | `srv607166` / `92.112.184.200`, Ubuntu 24.04, 4 cores, 15 GB |
| Deploy path | `/opt/leadgen` — **rsynced from the Mac, not a git checkout** |
| Database | Supabase `paasggeawsoctfgqbqrd`, Postgres 17 |
| Frontend | Netlify |
| Repo | the Mac. The server has no git remote; `git log` there tells you nothing |

```bash
# Everything below assumes:
cd /opt/leadgen
```

---

## 2. Daily / routine

### Is the fleet healthy?

```bash
docker compose ps
docker ps --format '{{.Names}}\t{{.Status}}' | grep leadgen
```

Twelve containers, all `Up`. `unhealthy` on a worker usually means the
healthcheck timed out at 5s while the worker was busy — check it is still
completing jobs before believing it:

```bash
docker logs --tail 20 leadgen-crawl-worker-1 | grep 'job finished'
```

### Is anything stuck or failing?

```sql
-- Queue depth by stage
select t.identifier, count(*), min(j.run_at)
  from graphile_worker._private_jobs j
  join graphile_worker._private_tasks t on t.id = j.task_id
 group by 1 order by 2 desc;

-- Failures. ALWAYS scope by time: an all-time count reports
-- stale failures forever and looks like an ongoing incident.
select stage, count(*), max(finished_at)
  from job_runs
 where started_at > now() - interval '2 hours' and status = 'failed'
 group by 1;

select * from dead_letter order by created_at desc limit 20;
select * from alerts where acknowledged_at is null order by last_seen_at desc;
```

### Deploy a code change

The server is an rsync target, so a change on the Mac is not live until you push
it *and rebuild*. **Each worker builds its own image**, so `docker compose build`
with no service argument is what you want after a shared-code change — otherwise
older images keep running with no indication.

```bash
# From the Mac, repo root:
rsync -az --exclude node_modules --exclude dist \
  workers/src workers/test workers/scripts workers/package.json \
  root@92.112.184.200:/opt/leadgen/workers/

# On the server:
cd /opt/leadgen
docker compose build            # no service arg — see above
docker compose up -d
```

**Check the queue is idle first** (§0.2).

### Start a campaign

From the UI, or by hand:

```bash
cd /opt/leadgen/workers
npx tsx scripts/niche-campaign.ts start "med spa" "Long Island NY" 100   # maps
npx tsx scripts/saas-campaign.ts  start "crm software" "United States" 100  # online
```

The UI's Start button calls the `start_campaign_v2` RPC, which picks
`maps:discover` or `saas:discover` from the niche. **It no longer calls the v1
Edge Functions** — see §6.

---

## 3. Incidents, by symptom

### "Discovery returns zero bytes / zero businesses"

**Check the proxy quota first, before anything in our stack.** Decodo exhausting
its traffic limit looks exactly like a code bug and has already invalidated one
measurement and cost several hours.

```bash
set -a; . /opt/leadgen/.env; set +a
curl -x "http://$DECODO_USERNAME:$DECODO_PASSWORD@$DECODO_HOST:$DECODO_PORT" \
     -s -o /dev/null -w '%{http_code}\n' https://api.ipify.org
```

`407` with `x-error-message: … reached your current traffic limit` is the
quota. Anything else, keep looking.

### "A campaign is stuck in running and nothing is moving"

```sql
select id, niche, status, current_step, updated_at from campaigns
 where status = 'running' order by updated_at;

select t.identifier, j.attempts, j.locked_at, left(j.last_error, 200)
  from graphile_worker._private_jobs j
  join graphile_worker._private_tasks t on t.id = j.task_id
 where j.payload->>'campaignId' = '<id>';
```

* **Jobs present, `locked_at` old** — a worker died holding the lock.
  `releaseStaleLocks` clears it at boot; restart that worker (§0.2 first).
* **Jobs present, `locked_at` null, `run_at` past** — nothing is consuming.
  The worker for that role is down or was never started for that stage.
* **No jobs at all** — the chain broke. `campaign:reconcile` on the scheduler
  re-derives what a campaign still owes; it runs on a cron and can be nudged by
  restarting `leadgen-scheduler-1`.

**Never scale the scheduler.** `campaign:reconcile` is a singleton.

### "Everything is Tier C / `not_deliverable:unknown`"

Verification is down. That is a statement about the verifier, **not** about the
mailboxes — an unknown is the absence of a verdict.

```bash
set -a; . /opt/leadgen/.env; set +a
curl -s -u "$VERIFALIA_USERNAME:$VERIFALIA_PASSWORD" \
  https://api.verifalia.com/v2.6/credits/balance
```

`creditPacks` near zero is the answer. Top up, then re-run the affected leads:

```bash
npx tsx scripts/rematch-leads.ts <campaignId> <ids.json>
```

Port 25 is blocked upstream by the host (`docs/hostinger-evidence.txt`), so
`VERIFIER=verifalia` has **no working fallback**. `verify-svc` cannot cover a
Verifalia outage until that changes.

### "SERP results are garbage / all dictionary definitions"

SearXNG answers HTTP 200 even when its upstreams are refusing it, so this fails
invisibly. Ask it directly:

```bash
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).unresponsive_engines))'
```

`Suspended: too many requests` or `CAPTCHA` on most engines means the exit IP is
burnt. SearXNG egresses through Decodo residential; re-render the config and
recreate it:

```bash
./infra/render-searxng-settings.sh
docker compose up -d --force-recreate searxng
```

### "The database is full / writes are failing"

**Supabase free plan stops at 500 MB and a project that reaches it goes
read-only** — which takes down the whole fleet, not one job.

```sql
select pg_size_pretty(pg_database_size(current_database()));
select relname, pg_size_pretty(pg_total_relation_size(relid))
  from pg_catalog.pg_statio_user_tables
 order by pg_total_relation_size(relid) desc limit 10;
```

`registry_entities` is almost always the largest. `registry:ingest` stops itself
at `REGISTRY_MAX_DB_MB` (400) and reports `complete: false`; if you are past
that, someone raised it. Reclaim by dropping a state's slice:

```sql
delete from registry_entities where state = 'XX';
```

### "A worker is crash-looping on EMAXCONNSESSION"

You have eight workers. See §0.3. Scale something down.

---

## 4. Cost control

Three budgets, three different mechanisms.

| Budget | Cap | Enforced by |
|---|---|---|
| Residential bytes | `METER_BUDGET_BYTES`, 2.5 GB/campaign | `proxy-meter` refuses new connections |
| Verification | `VERIFALIA_MAX_CENTS_PER_CAMPAIGN` = 3000 | `verify-worker`, per campaign |
| Registry disk | `REGISTRY_MAX_DB_MB` = 400 | `registry:ingest`, checked every 20 batches |

```sql
-- What a campaign actually spent
select source, stage, round(sum(cost_cents),1) cents,
       pg_size_pretty(sum(proxy_bytes)) bytes
  from source_costs where campaign_id = '<id>'
 group by 1,2 order by 3 desc;
```

**Known gap:** SearXNG proxies internally, so SERP's residential bytes never
pass through `ProxyPool` and are **not counted**. The per-campaign residential
budget is enforced against an undercount. Small today; fix is a meter in front
of SearXNG like `proxy-meter` in front of gosom.

**Measured baselines** — a run far outside these is worth investigating:

| | per business |
|---|---|
| Total cost, maps campaign | $0.0066 |
| Total cost, SaaS campaign | $0.0069 |
| Residential, maps discovery | 1.47 MB |
| Residential, SaaS campaign | 0.05 MB |

---

## 5. Registry

```bash
cd /opt/leadgen/workers

# Ingest one state for a niche
npx tsx scripts/registry-enqueue.ts CT "car wrap"
npx tsx scripts/registry-enqueue.ts FL "car wrap" quarterly   # 1.8 GB, ~15 min

# Prove a new adapter against live data, writing nothing
npx tsx scripts/adapter-probe.ts OR "car wrap" 25

# What would wider coverage add? Read-only, spends nothing.
npx tsx scripts/registry-coverage-delta.ts <campaignId>
```

**A registry slice is niche-scoped.** NY held 95,866 rows and named one extra
business on a car-wrap campaign, because those rows were ingested under *med
spa* tokens. Re-ingest per niche; do not assume a loaded state is loaded for
your niche. `registry:refresh` (Sunday 03:00 UTC) reads each state's scope back
out of `job_runs` so it cannot drift.

---

## 6. The v1 pipeline is still deployed

Eight v1 Edge Functions remain ACTIVE: `campaign-orchestrator`,
`step1-scrape-businesses`, `step2-enrich-contacts`, `apify-webhook`,
`owner-lookup`, `campaign-watchdog`, `campaigns-create`, `campaign-export`.

They drive **Google Places API + Apify**, writing into the same `leads` table
the worker fleet uses. Until 2026-08-27 the UI's Start button called them, which
meant the product's front door ran the pipeline this rebuild replaced. That is
now fixed (`start_campaign_v2`).

**Two live hazards remain:**

* **v1's pg_cron watchdog must stay unscheduled.** Verify before every run —
  it once raced v2 and scraped 100 businesses through the Places API into the
  same table:
  ```sql
  select count(*) from cron.job;   -- must be 0
  ```
* Calling `campaign-orchestrator` by hand — or any bookmark or script that
  still does — starts a v1 run.

`campaign-export` is still the export path and is **not** to be deleted.

---

## 7. Verification and IP reputation

`verify-svc` binds `0.0.0.0:8080` because outbound IP binding needs host
networking. It was once reachable from the internet with no authentication —
anyone could drive `POST /verify` and burn the IP reputation the whole
verification design rests on.

Closed by a `LEADGEN-FW` iptables chain, installed as
`leadgen-firewall.service`, script at `infra/leadgen-firewall.sh` (idempotent).

```bash
systemctl status leadgen-firewall
iptables -L LEADGEN-FW -n
```

**Every other LeadGen port is bound to `127.0.0.1`. Any new service must follow
that or get a rule.**

Testing note: `nc` from outside reports 8080 as "connected" regardless —
Hostinger's edge terminates inbound TCP, so a closed port times out rather than
refusing. **Only "does application data flow" is a valid test from off-box.**

---

## 8. Backups and recovery

* **Database** — Supabase's own backups. On the free plan those are limited;
  check before relying on them.
* **Code** — the Mac's git repo is the only copy. `/opt/leadgen` is a deploy
  target and will be overwritten by the next rsync. **Never edit code on the
  server**: the next deploy silently reverts it and you will spend an afternoon
  finding out why.
* **`registry_entities`** — rebuildable from the adapters, and cheaper to
  re-ingest than to restore.
* **Exports** — `exports/` is gitignored and holds customer records. Not backed
  up anywhere; treat a CSV there as the only copy.

---

## 9. Escalation — things needing a human decision

| Situation | Decision |
|---|---|
| Verifalia out of credits | Buy credits. No row can reach Tier A without it |
| Database near 500 MB | Supabase Pro ($25/mo, 8 GB) or drop a registry state |
| Named-rate needs CA/IL | Paid registry data — a purchasing decision |
| LinkedIn enrichment wanted | Supply `LINKEDIN_ACCOUNTS`, and say which worker to scale down |
| Port 25 needed | Hostinger will not unblock; needs a different host or provider |

---

## 10. Credential hygiene — outstanding

Recorded in `HANDOFF.md` §4 and still not done:

* `SUPABASE_ACCESS_TOKEN` was pasted into a chat transcript — **rotate it**.
* `APIFY_API_KEY` — v1 only, should be **revoked**.
* `OPENAI_API_KEY`, `GEONIX_API_KEY`, `TELEGRAM_*`, `VPS_SCRAPER_*`,
  `GOOGLE_CSE_*` — read by no code. Revoke rather than rotate.
* `searxng/settings.yml` contains the Decodo password and is gitignored. If you
  ever see it in `git status` as tracked, something has gone wrong.
