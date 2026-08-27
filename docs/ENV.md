# Environment variables

Every variable the fleet reads, where the value comes from, and which worker
reads it. `workers/src/config.ts` is the source of truth — it declares this same
list and refuses to boot when a required one is missing, so the two cannot
drift. `workers/test/config.test.ts` asserts the list stays in sync.

**Required?** is per worker role. A worker only demands what its own role needs,
so a `verify` worker starts without Decodo credentials while a `crawl` worker
does not.

## Core — every worker

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `DATABASE_URL` | **yes** | pgbouncer, set by docker-compose: `postgres://…@pgbouncer:6432/postgres` | all workers (app queries) |
| `DATABASE_URL_DIRECT` | **yes** | Supabase → Settings → Database → Connection string (**port 5432, not the 6543 pooler**) | all workers (graphile-worker LISTEN/NOTIFY), verify-svc |
| `SUPABASE_URL` | **yes** | Supabase → Settings → API → Project URL | all workers |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase → Settings → API → `service_role` secret | all workers |

> The two database URLs are **not** interchangeable. pgbouncer's transaction
> pooling gives every transaction a different backend connection, so a `LISTEN`
> registered on one is never the connection the `NOTIFY` arrives on. The queue
> does not crash — it silently stops waking on new jobs and degrades to a 2 s
> poll. Workers assert at boot that `DATABASE_URL_DIRECT` accepts `LISTEN` and
> refuse to start otherwise.

## pgbouncer

These exist because the pgbouncer image wants the connection split into parts.
Same credentials as `DATABASE_URL_DIRECT`.

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `SUPABASE_DB_HOST` | **yes** | `db.<ref>.supabase.co` | pgbouncer |
| `SUPABASE_DB_PORT` | no (5432) | — | pgbouncer |
| `SUPABASE_DB_USER` | **yes** | `postgres` | pgbouncer |
| `SUPABASE_DB_PASSWORD` | **yes** | Supabase → Settings → Database → password | pgbouncer |
| `SUPABASE_DB_NAME` | no (postgres) | — | pgbouncer |

## LLM

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **yes** for `crawl`, `enrich` | console.anthropic.com → API keys | crawl-worker, enrich-worker |

Missing → owner extraction falls back to regex only; logged loudly at boot.

## Proxies

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `DECODO_USERNAME` | **yes** for `maps`, `serp`, `crawl`, `linkedin` | Decodo dashboard → Residential | those workers, crawl4ai |
| `DECODO_PASSWORD` | same | same | same |
| `DECODO_HOST` | same | Decodo endpoint, e.g. `gate.decodo.com` | same |
| `DECODO_PORT` | same | Decodo endpoint port | same |
| `DECODO_STICKY_TTL` | no (600) | seconds a sticky session keeps one exit IP | ProxyPool |

`DECODO_STICKY_TTL` must exceed one full site crawl and one LinkedIn session —
an exit IP that changes mid-session gets the account challenged.

## Self-hosted services

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `SEARXNG_URL` | **yes** for `serp` | docker-compose sets `http://searxng:8080` | serp-worker |
| `CRAWL4AI_URL` | **yes** for `crawl` | docker-compose sets `http://crawl4ai:11235` | crawl-worker |
| `GOOGLE_MAPS_SCRAPER_URL` | **yes** for `maps` | docker-compose sets `http://maps-scraper:8080` | maps-worker |
| `SEARXNG_SECRET` | **yes** | generate: `openssl rand -hex 32` | searxng container |

## Google Places — fallback only

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `GOOGLE_PLACES_API_KEY` | no | Google Cloud Console → Credentials | maps-worker |

Discovery is the self-hosted scraper now. This key only resolves a `place_id`
the scraper could not. **Rotate the existing key before reuse** — it was in an
unignored `.env`.

## Registries

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `SOCRATA_APP_TOKEN` | no | evergreen.data.socrata.com/signup (free) | registry-worker |
| `REGISTRY_DATABASE_URL` | **yes** for `registry` | docker-compose builds it: `postgres://registry:…@registry-db:5432/registry` | registry-worker |
| `REGISTRY_DB_USER` | no (`registry`) | — | registry-db container |
| `REGISTRY_DB_PASSWORD` | **yes** | generate: `openssl rand -base64 24` | registry-db container, registry-worker |
| `REGISTRY_DB_NAME` | no (`registry`) | — | registry-db container |
| `REGISTRY_MAX_DB_MB` | no (20000) | your call | registry-worker |

Anonymous Socrata requests share a throttled pool. OpenCorporates has been
dropped — its free API tier no longer exists.

> **`registry_entities` and `zip_county` are not in Supabase.** They moved to a
> local Postgres on the VPS on 2026-08-27, because Supabase's free plan stops at
> 500 MB and the registry was 239 MB of it — and is the only table that grows
> without bound. Nothing user-facing reads them: no RLS policy, no Realtime
> subscription, no frontend query.
>
> `DATABASE_URL` and `REGISTRY_DATABASE_URL` are **not interchangeable**, and
> there is no query that joins across them. A script that reads `leads` and
> calls `county_for_zip` in one statement will fail — the function only exists
> in registry-db. `scripts/_db.ts` has both pools and the reasoning.
>
> From the Mac, open a tunnel first:
> `ssh -N -L 5433:127.0.0.1:5433 root@92.112.184.200`

## Verification

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `VERIFY_URL` | **yes** for `verify` | docker-compose sets `http://verify-svc:8080` | verify-worker |
| `VERIFY_IPS` | **yes** for `verify` | your VPS's public IPs, comma separated | verify-worker, **verify-svc** |
| `VERIFY_HELO_DOMAIN` | **yes** for `verify` | a domain you own that is *not* a sending domain | verify-worker, **verify-svc** |
| `VERIFY_FROM_EMAIL` | **yes** for `verify` | a real mailbox on `VERIFY_HELO_DOMAIN` | verify-worker, **verify-svc** |
| `VERIFIER` | no (`hybrid`) | `reacher` \| `verifalia` \| `hybrid` | verify-worker |
| `VERIFALIA_USERNAME` | no | verifalia.com → Sub-accounts | verify-worker |
| `VERIFALIA_PASSWORD` | no | same | verify-worker |
| `VERIFALIA_MAX_CENTS_PER_CAMPAIGN` | no (500) | your call | verify-worker |

Each IP in `VERIFY_IPS` needs **PTR/rDNS** resolving to `VERIFY_HELO_DOMAIN`,
and an **SPF** record on that domain listing the IP. `VERIFY_FROM_EMAIL` must be
a deliverable mailbox — some servers check the sender before answering `RCPT`.

`VERIFIER=reacher` is retained as an alias for the self-hosted provider so
pre-swap config keeps working; it routes to verify-svc.

## LinkedIn

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `LINKEDIN_ACCOUNTS` | no | aged accounts you supply | linkedin-worker |

Format `email:password:li_at,email:password:li_at`. The `li_at` cookie can
contain colons — only the first two separate fields. Empty → SERP-only
LinkedIn discovery.

## Runtime

| Variable | Required? | Where to get it | Read by |
|---|---|---|---|
| `WORKER_ROLE` | no (`all`) | set per container by docker-compose | worker entrypoint |
| `WORKER_CONCURRENCY` | no (5) | your call | graphile-worker |
| `LOG_LEVEL` | no (`info`) | `debug`\|`info`\|`warn`\|`error` | all |
| `METRICS_PORT` | no (9100) | — | all workers |
| `PORT` | no (8080) | — | verify-svc |

---

## New in Phase 1, not in the original brief

Called out because the brief requires new variables to be flagged:

| Variable | Why it exists |
|---|---|
| `DATABASE_URL_DIRECT` | Replaces the brief's single `DATABASE_URL (pooler)`. graphile-worker needs session mode; one URL cannot serve both. |
| `SUPABASE_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | pgbouncer's image takes connection parts, not a URL. |
| `SEARXNG_SECRET` | SearXNG refuses to start without one. |
| `WORKER_ROLE` | Selects which task types a container registers, so stages scale independently. |
| `PORT` | verify-svc's listen port. |
| `VERIFY_*` | Renamed from the brief's `REACHER_*` after the switch to verify-svc. |

Dropped: `OPENCORPORATES_API_KEY` (no free tier), `REACHER_URL` / `REACHER_IPS`
/ `REACHER_HELO_DOMAIN` / `REACHER_FROM_EMAIL` (renamed to `VERIFY_*`).
