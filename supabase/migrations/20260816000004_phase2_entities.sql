-- Phase 2: the entity model the multi-source pipeline writes into.
--
-- `leads` stays as the campaign-scoped working row the existing UI reads, so v1
-- keeps rendering. The new tables are the deduplicated, cross-campaign layer:
-- a business seen in two campaigns is one `businesses` row, and a person found
-- once is free forever after.
--
-- Additive only. No v1 column is dropped.

-- ── businesses ───────────────────────────────────────────────────────────────
--
-- Dedupe key is the normalised domain, falling back to name+phone when a
-- business has no website. Both are expressed as partial unique indexes rather
-- than one composite key, because "no domain" is common and NULLs would not
-- collide.

create table if not exists public.businesses (
  id            uuid primary key default gen_random_uuid(),
  domain        text,
  name          text not null default '',
  name_norm     text not null default '',
  phone         text not null default '',
  website       text not null default '',
  street        text not null default '',
  city          text not null default '',
  state         text not null default '',
  postal_code   text not null default '',
  country       text not null default '',
  county        text not null default '',
  category      text not null default '',
  place_id      text not null default '',
  latitude      double precision,
  longitude     double precision,
  rating        numeric(3,2),
  review_count  int not null default 0,
  mx_ok         boolean,
  domain_catch_all boolean,
  sources       text[] not null default '{}',
  evidence      jsonb  not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create unique index if not exists businesses_domain_uniq
  on public.businesses (domain) where domain is not null and domain <> '';
create unique index if not exists businesses_name_phone_uniq
  on public.businesses (name_norm, phone)
  where (domain is null or domain = '') and phone <> '';
-- Registry matching in Phase 3 joins on this.
create index if not exists businesses_name_trgm
  on public.businesses using gin (name_norm gin_trgm_ops);
create index if not exists businesses_geo on public.businesses (state, city);

-- ── people ───────────────────────────────────────────────────────────────────

create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  linkedin_url  text,
  first_name    text not null default '',
  last_name     text not null default '',
  full_name     text not null default '',
  title         text not null default '',
  is_doctor     boolean not null default false,
  domain        text not null default '',
  location      text not null default '',
  sources       text[] not null default '{}',
  evidence      jsonb  not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create unique index if not exists people_linkedin_uniq
  on public.people (linkedin_url) where linkedin_url is not null and linkedin_url <> '';
create unique index if not exists people_name_domain_uniq
  on public.people (lower(first_name), lower(last_name), domain)
  where (linkedin_url is null or linkedin_url = '') and domain <> '';

-- ── contacts ─────────────────────────────────────────────────────────────────
--
-- A person↔business edge carrying one email and its verdict. This is the row
-- the export reads. `tier` is the Phase 2 replacement for v1's binary
-- gate_passed: Tier B (catch-all, well corroborated) is the bucket that
-- recovers the 52% of named leads v1 discarded.

create table if not exists public.contacts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses(id) on delete cascade,
  person_id     uuid references public.people(id) on delete set null,
  campaign_id   uuid references public.campaigns(id) on delete cascade,
  lead_id       uuid references public.leads(id) on delete cascade,
  email         text not null default '',
  email_kind    text not null default 'owner' check (email_kind in ('owner','general')),
  status        text not null default '' ,          -- safe|invalid|risky|unknown
  is_catch_all  boolean not null default false,
  is_role       boolean not null default false,
  is_disposable boolean not null default false,
  provider      text not null default '',
  tier          text check (tier in ('A','B','C','rejected')),
  score         int  not null default 0,
  reject_reason text not null default '',
  sources       text[] not null default '{}',
  evidence      jsonb  not null default '{}'::jsonb,
  verified_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists contacts_campaign_tier on public.contacts (campaign_id, tier);
create index if not exists contacts_business on public.contacts (business_id);
create unique index if not exists contacts_campaign_email_uniq
  on public.contacts (campaign_id, email) where email <> '';

-- ── domain_patterns ──────────────────────────────────────────────────────────
--
-- Learned email shape per domain, kept forever. One verified address on a
-- domain teaches the pattern for every future lead there, which is what turns
-- guessing into inference.

create table if not exists public.domain_patterns (
  domain      text primary key,
  pattern     text not null,          -- first | first.last | flast | firstl | f.last | first_last | last
  confidence  numeric(3,2) not null default 0.5,
  learned_from text not null default '',
  samples     int not null default 1,
  catch_all   boolean,
  catch_all_checked_at timestamptz,
  updated_at  timestamptz not null default now()
);

-- ── tech_stack ───────────────────────────────────────────────────────────────

create table if not exists public.tech_stack (
  domain      text not null,
  technology  text not null,
  category    text not null default '',
  detected_at timestamptz not null default now(),
  primary key (domain, technology)
);

-- ── serp_cache ───────────────────────────────────────────────────────────────

create table if not exists public.serp_cache (
  query_hash  text primary key,
  query       text not null,
  engine      text not null default 'searxng',
  results     jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now()
);

create index if not exists serp_cache_fetched on public.serp_cache (fetched_at);

-- ── leads: the Phase 2 columns ───────────────────────────────────────────────

alter table public.leads
  add column if not exists business_id uuid references public.businesses(id) on delete set null,
  add column if not exists tier        text check (tier in ('A','B','C','rejected')),
  add column if not exists score       int  not null default 0,
  add column if not exists sources     text[] not null default '{}',
  add column if not exists evidence    jsonb  not null default '{}'::jsonb,
  add column if not exists county      text not null default '',
  add column if not exists category    text not null default '',
  add column if not exists crawl_done  boolean not null default false,
  add column if not exists enrich_done boolean not null default false;

create index if not exists leads_campaign_tier on public.leads (campaign_id, tier);
create index if not exists leads_campaign_crawl on public.leads (campaign_id, crawl_done);

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- businesses/people/domain_patterns/tech_stack/serp_cache are deliberately
-- cross-user reference data written only by the service role: a domain's email
-- pattern is not one user's property, and re-deriving it per user would waste
-- the verification budget the cache exists to save. Only campaign-scoped rows
-- get per-user policies.

alter table public.contacts enable row level security;
drop policy if exists "contacts: campaign owner" on public.contacts;
create policy "contacts: campaign owner" on public.contacts for select
  using (exists (select 1 from public.campaigns c
                 where c.id = campaign_id and c.user_id = auth.uid()));

alter table public.businesses      enable row level security;
alter table public.people          enable row level security;
alter table public.domain_patterns enable row level security;
alter table public.tech_stack      enable row level security;
alter table public.serp_cache      enable row level security;
-- No authenticated policies on those five: service-role only.

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='contacts') then
    alter publication supabase_realtime add table public.contacts;
  end if;
end $$;
