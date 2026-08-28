-- registry-db schema.
--
-- A verbatim reproduction of what `registry_entities` and `zip_county` were in
-- Supabase, so `registry:match` and `registry:ingest` run against an identical
-- shape and no query needed changing. Copied from
-- `supabase/migrations/20260817000001_phase3_registry_serp.sql` and
-- `…0002_phase4_mailbox.sql`, with two deliberate differences noted below.
--
-- ── Why this database exists ─────────────────────────────────────────────────
--
-- Supabase is on the free plan: 500 MB, and a project that reaches it goes
-- read-only, which takes the whole fleet down rather than one job. The registry
-- was 238 MB of a 276 MB database and is the only table that grows without
-- bound — five states of car-wrap-scoped entities is 304k rows, and whole-state
-- slices across fifty states would be tens of millions.
--
-- None of it is user-facing. It is a lookup table the workers consult; no RLS
-- policy references it, no Realtime subscription watches it, and the frontend
-- has never read it. So it moves to a local Postgres on the same box as the
-- workers, where disk is 122 GB rather than 500 MB and the round trip is a
-- container hop rather than a pooled connection to us-east-1.
--
-- ── The two differences from the Supabase original ───────────────────────────
--
-- 1. No `public.` schema qualification is *required* here, but it is kept, so
--    the DDL diffs cleanly against the migration it came from.
-- 2. `note_zip_county` is not recreated. It was written for a per-row ingest
--    path that `upsertEntities` replaced with a single batched statement, and
--    nothing has called it since. Carrying a dead function into a new database
--    would be carrying it forward for no reason.

create extension if not exists pg_trgm;
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ── registry_entities ────────────────────────────────────────────────────────
--
-- One row per registered entity per state. `officers` is a jsonb array rather
-- than a child table because it is written and read whole, never queried into:
-- the match picks an entity first, then walks its officers in priority order.

create table if not exists public.registry_entities (
  id            uuid primary key default gen_random_uuid(),
  -- Two-letter state of the registry, not of the address.
  state         text not null,
  entity_id     text not null,
  name          text not null default '',
  name_norm     text not null default '',
  status        text not null default '',
  entity_type   text not null default '',
  county        text not null default '',
  city          text not null default '',
  state_code    text not null default '',
  postal_code   text not null default '',
  street        text not null default '',
  filing_date   date,
  officers      jsonb not null default '[]'::jsonb,
  raw           jsonb not null default '{}'::jsonb,
  ingested_at   timestamptz not null default now()
);

create unique index if not exists registry_entities_uniq
  on public.registry_entities (state, entity_id);
-- The match query is `name_norm % $1 and state = $2 and county = $3`, so the
-- trigram index carries the expensive half.
create index if not exists registry_entities_name_trgm
  on public.registry_entities using gin (name_norm gin_trgm_ops);
create index if not exists registry_entities_scope
  on public.registry_entities (state, county);
create index if not exists registry_entities_zip
  on public.registry_entities (state, postal_code);
-- Only entities that actually named a person are worth scanning.
create index if not exists registry_entities_has_person
  on public.registry_entities (state, county)
  where officers <> '[]'::jsonb;
-- `officers @> '[{"first":"Uzma","last":"Iqbal"}]'` is the reverse lookup.
-- jsonb_path_ops indexes only containment, which is all this asks, and is
-- substantially smaller than the default opclass.
create index if not exists registry_entities_officers_gin
  on public.registry_entities using gin (officers jsonb_path_ops);

-- ── zip_county ───────────────────────────────────────────────────────────────
--
-- Built from the registries themselves rather than shipped as a static file:
-- it maps a ZIP to the county the registry itself files it under. `weight` is
-- the observation count, so the lookup takes the majority county for a ZIP.

create table if not exists public.zip_county (
  postal_code text not null,
  state       text not null,
  county      text not null,
  weight      int  not null default 1,
  -- 'registry' — derived from filings, the original bootstrap.
  -- 'census'   — the Census ZCTA→county crosswalk, loaded by
  --              scripts/zip-county-load.ts.
  --
  -- Both are kept. The derived rows are a record of where entities actually
  -- file, which is occasionally the more useful answer, but they are not a
  -- geography: a registered-agent address put 07306 (Jersey City NJ) in
  -- Suffolk and 10996 (West Point, Orange County) in Saratoga. So census wins
  -- when both have an opinion, and registry rows remain as the fallback for a
  -- ZIP the crosswalk does not cover.
  source      text not null default 'registry',
  primary key (postal_code, state, county)
);

create index if not exists zip_county_lookup
  on public.zip_county (postal_code, state);

create or replace function public.county_for_zip(p_zip text, p_state text)
returns text language sql stable as $$
  select county from public.zip_county
   where postal_code = left(regexp_replace(coalesce(p_zip,''), '[^0-9]', '', 'g'), 5)
     and state = upper(coalesce(p_state,''))
   -- Authoritative first, then by weight. For census rows weight is the land
   -- area of the ZIP's intersection with the county, so the majority county
   -- wins; for registry rows it is an observation count.
   order by (source = 'census') desc, weight desc, county
   limit 1
$$;

-- ── ingest bookkeeping ───────────────────────────────────────────────────────
--
-- The scope each state was last ingested under. Previously this was read back
-- out of Supabase's `job_runs.detail`, which worked but coupled the refresh to
-- a table it otherwise has no business in — and which now lives in a different
-- database entirely. Recording it beside the data it describes means
-- `registry:refresh` needs exactly one connection.
--
-- `job_runs` in Supabase still gets the same detail written to it; this is not
-- a replacement for the audit trail, it is the thing the refresh reads.

create table if not exists public.registry_ingest_runs (
  state         text primary key,
  adapter       text not null default '',
  mode          text,
  name_contains text[] not null default '{}',
  counties      text[] not null default '{}',
  -- True when the slice is deliberately unscoped: the whole state, not a niche.
  --
  -- Without this, an empty `name_contains` is ambiguous — it is either "load
  -- everything" or a bad record, and `registry:refresh` cannot tell. It used to
  -- resolve that by skipping empty scopes, which was right when unscoped meant
  -- accidental and becomes silently wrong the moment a whole state is loaded on
  -- purpose: NY would simply stop being refreshed.
  whole_state   boolean not null default false,
  seen          bigint not null default 0,
  written       bigint not null default 0,
  with_person   bigint not null default 0,
  skipped_anonymous bigint not null default 0,
  -- False when the ingest stopped on the disk ceiling rather than at the end of
  -- the slice. The difference between "this state is loaded" and "this state is
  -- loaded as far as the disk allowed" is something every consumer of a
  -- coverage number needs to see.
  complete      boolean not null default true,
  db_mb_end     int,
  finished_at   timestamptz not null default now()
);
