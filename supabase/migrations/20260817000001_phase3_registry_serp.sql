-- Phase 3: state business registries, SERP owner lookup, and the name-class model.
--
-- Three things land here:
--
--   1. `registry_entities` — officer names from state bulk data. This is the
--      source aimed at the actual Phase 2 wall: 21 of 75 leads had a person
--      extracted from the site and were rejected because their title was not
--      owner-grade. A registry officer *is* owner-grade by construction.
--
--   2. `zip_county` — the crosswalk registry matching keys on. NY's
--      `location_city` is 8.3% populated and useless for matching, while
--      `county` is 100% populated, so county is the join key and ZIP is how a
--      Maps business (which has a ZIP, not a county) gets one.
--
--   3. `name_class` / `corroboration` on leads and contacts — the replacement
--      for the binary owner-title gate. A clinical title (NP, PA, MD, CRNA…)
--      is no longer discarded; it is held as `clinical_lead` and promoted to
--      owner-grade only when a second, independent source agrees.
--
-- Additive only. Nothing from Phase 1 or 2 is dropped.

-- ── registry_entities ────────────────────────────────────────────────────────
--
-- One row per registered entity per state. `officers` is a jsonb array rather
-- than a child table because it is written and read whole, never queried into:
-- the match picks an entity first, then walks its officers in priority order.
--
-- Officer entries look like:
--   {"name":"UZMA IQBAL","title":"CEO","first":"Uzma","last":"Iqbal",
--    "kind":"person","source_field":"chairman_name","rank":2}
-- `kind` is 'person' | 'company' | 'unknown'. FL supplies it directly (a P/C
-- flag per officer); NY and CO have to infer it, which is what
-- lib/registry-name.ts does.

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

-- ── zip_county ───────────────────────────────────────────────────────────────
--
-- Built from the registries themselves rather than shipped as a static file:
-- NY's dataset carries (dos_process_zip, county) on 4.19M rows, which is a
-- better crosswalk for *this* purpose than a census file, because it maps ZIPs
-- to the county the registry itself files them under. `weight` is the
-- observation count, so the lookup takes the majority county for a ZIP.

create table if not exists public.zip_county (
  postal_code text not null,
  state       text not null,
  county      text not null,
  weight      int  not null default 1,
  primary key (postal_code, state, county)
);

create or replace function public.county_for_zip(p_zip text, p_state text)
returns text language sql stable as $$
  select county from public.zip_county
   where postal_code = left(regexp_replace(coalesce(p_zip,''), '[^0-9]', '', 'g'), 5)
     and state = upper(coalesce(p_state,''))
   order by weight desc, county
   limit 1
$$;

-- Bump-or-insert, so repeated ingests sharpen the majority rather than reset it.
create or replace function public.note_zip_county(p_zip text, p_state text, p_county text)
returns void language plpgsql as $$
declare z text := left(regexp_replace(coalesce(p_zip,''), '[^0-9]', '', 'g'), 5);
begin
  if z = '' or coalesce(p_county,'') = '' then return; end if;
  insert into public.zip_county (postal_code, state, county, weight)
  values (z, upper(p_state), p_county, 1)
  on conflict (postal_code, state, county)
    do update set weight = public.zip_county.weight + 1;
end $$;

-- ── serp_cache: make the 30-day rule enforceable ─────────────────────────────
--
-- The table exists from Phase 2 and is empty. It has no unique key on `query`
-- itself (the hash is the pk), which is correct, but the engine and the query
-- string need to be part of what identifies a cache entry once more than one
-- query shape exists.

alter table public.serp_cache
  add column if not exists hit_count int not null default 0;

-- ── leads: the naming-provenance columns ─────────────────────────────────────
--
-- `name_class` is what replaces "did isOwnerTitle() return true". `corroboration`
-- is the array of independent sources that agreed, which is what promotes a
-- clinical_lead to owner-grade and what a human reads when auditing a row.

alter table public.leads
  add column if not exists name_class      text not null default '',
  add column if not exists corroboration   text[] not null default '{}',
  add column if not exists registry_entity_id uuid references public.registry_entities(id) on delete set null,
  add column if not exists match_confidence  numeric(4,3),
  add column if not exists tier_reason     text not null default '',
  add column if not exists name_done       boolean not null default false;

create index if not exists leads_campaign_name_done
  on public.leads (campaign_id, name_done);

-- ── contacts: carry the same provenance onto the exported row ────────────────

alter table public.contacts
  add column if not exists name_class    text not null default '',
  add column if not exists corroboration text[] not null default '{}',
  add column if not exists tier_reason   text not null default '';

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- registry_entities and zip_county are cross-user reference data written only
-- by the service role, matching the Phase 2 treatment of businesses/people:
-- a state's corporate filings are not one user's property, and re-ingesting
-- 4.2M rows per user would be absurd.

alter table public.registry_entities enable row level security;
alter table public.zip_county        enable row level security;
-- No authenticated policies: service-role only.
