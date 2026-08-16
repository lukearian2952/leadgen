# v1 → v2 Migration Plan

Companion to `ARCHITECTURE.md`. This is the ordering: what changes, in what sequence, and
what must keep working throughout.

**Guiding constraint:** v1 stays runnable until Phase 2 proves v2 end-to-end on the same
100-lead benchmark. No destructive DB migration runs before that.

---

## 0. Repo shape

v1 is a single Vite app with Deno edge functions. v2 adds a worker package. Target layout:

```
Lead Gen/
├── src/                        # React frontend — stays
├── supabase/
│   ├── migrations/             # additive only, from here on
│   └── functions/              # shrinks to near-zero (see §4)
├── workers/                    # NEW — Node/TS, graphile-worker
│   ├── src/
│   │   ├── lib/                # ported _shared/* (identity, geo, niche, dns, llm…)
│   │   ├── sources/            # maps, serp, crawl, linkedin, registry
│   │   ├── verify/             # VerifierProvider: reacher, verifalia
│   │   ├── tasks/              # one file per graphile job type
│   │   └── proxy/              # ProxyPool
│   └── package.json
├── docker-compose.yml          # NEW
├── .env.example                # NEW (Phase 1 deliverable)
└── docs/
```

`workers/` is a separate package with its own `package.json` — the frontend must not pull
in worker dependencies, and the workers must not pull in React.

**Before any of this:** `git init`, a real `.gitignore` (`.env`, `.env.local`, `dist`,
`node_modules`, `.netlify`, `supabase/.temp`), and rotate the keys currently sitting in
plaintext in `.env`. See `ARCHITECTURE.md` §8.7.

---

## 1. Code port order

Ported in dependency order, each with Vitest coverage as it lands (Phase 1 for the pure
functions, since they are the cheapest possible tests and the gate depends on them):

1. `identity.ts` — no dependencies. Port first, test hardest. Add the registry
   person-vs-company classifier here (`isCommercialAgent`, entity-name-repeat detection).
2. `geo.ts`, `niche-types.ts`, `owner-patterns.ts` — depend on nothing but each other.
3. `dns.ts` — swap `fetch` for the ProxyPool-aware client.
4. `llm.ts` — unchanged logic; add URL-hash response caching to hit the ≤1 call/lead/stage
   target.
5. `crawl.ts` — keep `htmlToText` and `nameAppearsInText`; the fetch/link-discovery loop is
   replaced by crawl4ai.
6. `verifalia.ts` — wrap in `VerifierProvider` without touching its internals.
7. `gate.ts` — becomes `tierA()` inside the new scorer; `evaluateGate` keeps its exact
   semantics so v1 and v2 verdicts can be diffed on the same rows.

Deno-isms to strip on the way: `Deno.env.get` → `process.env` behind a validated config
module, `npm:@supabase/supabase-js@2` → a normal dependency, `Deno.serve` → nothing (jobs,
not HTTP handlers).

> Dependency installs: I will list exactly what `workers/package.json` needs and ask you
> to run the install — per your standing rule, I do not run `npm install` myself.

---

## 2. Database migration

**All additive.** No column is dropped in Phase 1–4; v1 columns are left in place so a v1
campaign row still renders. Cleanup is a Phase 5 decision, once nothing reads them.

### Phase 1 migrations
- `graphile_worker` schema — installed by the library's own migrator, not by hand.
- `job_runs`, `dead_letter`, `verifier_ip_state`, `source_costs`.
- `pg_trgm` extension (needed in Phase 3, cheap to enable now).

### Phase 2 migrations
- `businesses`, `people`, `contacts`, `domain_patterns`, `tech_stack`, `serp_cache`.
- `leads.sources text[]`, `leads.evidence jsonb`, `leads.tier text`, `leads.score int`.
- RLS on every new table, matching the existing per-user pattern.

### Phase 3 migrations
- `registry_entities` + trigram indexes on the normalised name column.

### Deprecated but retained until Phase 5
`campaigns.apify_run_id`, `campaigns.apify_phase`, `campaigns.current_step` (20/21
sentinels), `campaigns.step3_done`, `step5_done`, `stat_content`, `maps_only`,
`leads.verifalia_job_url`, `verifalia_patterns`, `verifalia_submitted_at`,
`leads.website_content`, `leads.step3_done`, `leads.step5_done`, `leads.company_size`.

### Things to actively turn off
- The `campaign-watchdog` pg_cron job — unschedule it the moment `campaign-reconcile`
  takes over, or both will act on the same campaign.
- `claim_campaign_step` — drop only after no edge function calls it.

---

## 3. Data migration

None required. `campaigns` and `leads` keep their primary keys and their history. v2
backfills `businesses`/`people`/`contacts` lazily: the first v2 run over an existing
campaign populates them. Old campaigns keep rendering from `leads` alone.

`domain_patterns` starts empty and warms up. Any v1 lead with a verified
`owner_email` + non-empty `owner_first_name` is a free training row for pattern inference
— worth a one-off backfill script in Phase 2 (est. a few hundred rows, no API cost).

---

## 4. Edge functions: what happens to each

| Function | Fate |
|---|---|
| `campaigns-create` | **Keep.** Small, works, sits on the request path. Also fix: it currently falls back to "the first user in the system" when there is no JWT — that is fine with one user and a data leak with two. |
| `campaign-export` | **Keep briefly, then move.** Export becomes per-tier in Phase 5; it can stay an edge function since it is short and request-driven. |
| `campaign-orchestrator` | **Delete** at Phase 2. Replaced by enqueueing a `campaign:discover` job. |
| `step1-scrape-businesses` | **Delete** at Phase 2 → `maps-worker`. |
| `step2-enrich-contacts` | **Delete** at Phase 2 → job graph. |
| `owner-lookup` | **Delete** at Phase 3 → crawl/registry/linkedin/enrich workers. |
| `apify-webhook` | **Delete** at Phase 2. Nothing calls back any more. |
| `campaign-watchdog` | **Delete** at Phase 2 → `campaign-reconcile` cron job. |

The frontend's `useCampaignRunner` stops calling the orchestrator and instead calls an
RPC that enqueues the job — satisfying the brief's "no browser-side status writes; every
mutation via RPC". Note `useCampaignRunner.stop()` currently writes
`status: 'paused'` straight from the browser; that is exactly the pattern being removed.

---

## 5. Interpretation I need to flag

The Phase 0 brief lists **Verifalia** among the things to delete, but §F.2 specifies a
hybrid verifier with Verifalia as the safety net, `VERIFIER=hybrid` as the default, and
per-campaign Verifalia spend caps.

I have taken §F.2 as authoritative — it is the more specific and later instruction — so
**Verifalia is demoted to fallback, not deleted.** Its client moves behind
`VerifierProvider` unchanged. If you actually want it gone entirely, say so and I will
drop the provider and make Reacher the only verifier; that decision interacts with the
Reacher licensing question in `ARCHITECTURE.md` §8.1, since removing Verifalia would
leave no verifier at all if you decline the Reacher licence.

---

## 6. Rollback

Through Phase 4, v1 remains deployable: its edge functions are untouched until the phase
that deletes them, and every DB change is additive. Rolling back = redeploying the v1
functions and unscheduling `campaign-reconcile`. After Phase 5's column cleanup, rollback
requires a restore, so that cleanup happens only once v2 has run the 1,000-lead
benchmark.
