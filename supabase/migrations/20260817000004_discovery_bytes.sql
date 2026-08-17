-- Discovery byte accounting and resumable city coverage.
--
-- Two problems, one table each.
--
-- 1. Maps residential traffic was never attributed. `source_costs` has a
--    proxy-bytes column and every other stage populates it; discovery could
--    not, because gosom egresses from its own process. proxy-meter now
--    measures it, and `maps:discover` writes the figure through the same
--    `add_source_cost` path as everything else — so "MB per business
--    discovered" becomes a query rather than a guess.
--
-- 2. A retried discovery re-scraped cities that had already returned results.
--    Every retry was therefore paying full residential price for rows already
--    in the database. Cities are now recorded as they complete, and a resumed
--    run skips them.

create table if not exists public.discovery_city_runs (
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  city         text not null,
  -- All phrasings for this city are one unit of work: they are issued in the
  -- same scraper job and share its cost.
  queries      text[] not null default '{}',
  status       text not null default 'ok' check (status in ('ok','empty','failed')),
  rows_returned int not null default 0,
  kept         int not null default 0,
  batch_index  int not null default 0,
  ran_at       timestamptz not null default now(),
  primary key (campaign_id, city)
);

create index if not exists discovery_city_runs_campaign
  on public.discovery_city_runs (campaign_id, ran_at desc);

comment on table public.discovery_city_runs is
  'Cities already scraped for a campaign. A resumed or retried discovery skips '
  'any row here with status ok, so a retry never re-buys results it already has.';

alter table public.discovery_city_runs enable row level security;
-- Service-role only, like the other pipeline bookkeeping tables.

-- ── residential budget ───────────────────────────────────────────────────────
--
-- Enforced in ProxyPool for the stages it owns and in proxy-meter for
-- discovery. Stored per campaign so a single runaway scrape cannot spend the
-- month's allowance; the default is set by the caller, not here, because the
-- right number depends on the target count.

alter table public.campaigns
  add column if not exists residential_budget_bytes bigint,
  add column if not exists residential_used_bytes bigint not null default 0;

comment on column public.campaigns.residential_budget_bytes is
  'Residential proxy bytes this campaign may spend. NULL = unlimited. '
  'Default applied at creation is 2 GB per 1,000 target businesses.';

/**
 * Add residential bytes and report whether the campaign is now over budget.
 * Atomic so concurrent crawl workers cannot both read "under" and both spend.
 */
create or replace function public.add_residential_bytes(
  p_campaign uuid, p_bytes bigint
) returns table (used bigint, budget bigint, over boolean)
language plpgsql as $$
begin
  update public.campaigns
     set residential_used_bytes = residential_used_bytes + greatest(p_bytes, 0)
   where id = p_campaign
  returning residential_used_bytes, residential_budget_bytes
       into used, budget;

  over := budget is not null and used >= budget;
  return next;
end $$;
