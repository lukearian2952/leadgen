-- Pre-flight census: predict a campaign's Tier-A yield before running it.
--
-- ── What this encodes ────────────────────────────────────────────────────────
--
-- Three campaigns established that one cheap number predicts Tier A, and that
-- named-rate does not:
--
--   niche       on-domain personal addresses    Tier A
--   med spa                  2                     1
--   dental                  12                     5
--   vehicle wrap            13                     9
--
-- Wrap had the *lowest* named-rate of the three (34%) and the highest Tier A.
-- So the qualifying question for a new niche is not "can we find owners" but
-- "do these businesses own their mail", and that is answerable by crawling
-- twenty of them.
--
-- Two tables: the calibration points (which grow as campaigns finish, so the
-- prediction sharpens) and the census results themselves.

-- ── calibration ──────────────────────────────────────────────────────────────
--
-- One row per completed campaign. `sample_size` is the denominator both rates
-- are over, so points from a 75-business run and a 1,000-business run can be
-- weighted rather than averaged blindly.

create table if not exists public.preflight_calibration (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references public.campaigns(id) on delete set null,
  niche         text not null default '',
  location      text not null default '',
  sample_size   int  not null,
  -- Businesses with >= 1 personal address on their own domain, per 100.
  on_domain_personal_rate numeric(6,3) not null,
  -- Raw count, kept because the rate hides how thin a small sample was.
  on_domain_personal_count int not null default 0,
  named_rate    numeric(6,3) not null default 0,
  tier_a_rate   numeric(6,3) not null default 0,
  tier_ab_rate  numeric(6,3) not null default 0,
  recorded_at   timestamptz not null default now()
);

create index if not exists preflight_calibration_niche
  on public.preflight_calibration (niche, recorded_at desc);

-- ── census runs ──────────────────────────────────────────────────────────────

create table if not exists public.preflight_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,
  niche         text not null,
  location      text not null,
  sample_size   int  not null default 20,
  status        text not null default 'running'
                check (status in ('running','complete','failed')),
  -- Census output.
  businesses_found     int not null default 0,
  businesses_with_site int not null default 0,
  addresses_seen       int not null default 0,
  on_domain_addresses  int not null default 0,
  on_domain_personal   int not null default 0,
  businesses_with_personal int not null default 0,
  named                int not null default 0,
  -- Prediction, as a band rather than a point: three calibration points do not
  -- support more precision than that, and a single number would imply they do.
  predicted_tier_a_low  numeric(6,3),
  predicted_tier_a_high numeric(6,3),
  predicted_band        text not null default '',
  estimated_cost_usd    numeric(8,4),
  error         text not null default '',
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists preflight_runs_user on public.preflight_runs (user_id, created_at desc);

alter table public.preflight_runs enable row level security;
drop policy if exists "preflight: owner" on public.preflight_runs;
create policy "preflight: owner" on public.preflight_runs for select
  using (user_id = auth.uid());

alter table public.preflight_calibration enable row level security;
-- Calibration is cross-user reference data, like domain_patterns: what a niche
-- yields is not one customer's property, and re-deriving it per user would
-- mean every user pays for the same twenty crawls.

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public'
                    and tablename='preflight_runs') then
    alter publication supabase_realtime add table public.preflight_runs;
  end if;
end $$;

-- ── seed the three points we measured ────────────────────────────────────────
--
-- Inserted only if absent, so re-running the migration cannot double-count them.

insert into public.preflight_calibration
  (niche, location, sample_size, on_domain_personal_rate, on_domain_personal_count,
   named_rate, tier_a_rate, tier_ab_rate)
select * from (values
  ('med spa',           'Long Island, NY',  75, 2.667,  2, 42.667, 1.333, 14.667),
  ('dental practice',   'Long Island, NY',  79, 15.190, 12, 51.899, 6.329, 16.456),
  ('vehicle wrap shop', 'New York',        100, 13.000, 13, 34.000, 9.000, 23.000)
) as v(niche, location, sample_size, on_domain_personal_rate, on_domain_personal_count,
       named_rate, tier_a_rate, tier_ab_rate)
where not exists (
  select 1 from public.preflight_calibration c where c.niche = v.niche and c.campaign_id is null
);
