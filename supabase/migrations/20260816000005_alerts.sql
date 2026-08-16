-- Operator alerts.
--
-- The failure this exists for: Verifalia returned HTTP 402 (out of credits) for
-- an entire Phase 2 run. The code handled it correctly — logged it, returned
-- `unknown`, spent nothing, fabricated no verdicts — and that was the problem.
-- It degraded *silently*. The fallback that the whole verification design leans
-- on was gone, every candidate came back unknown, and the only trace was a line
-- in a container log nobody was reading.
--
-- A verifier that cannot run is not a per-lead condition, it is a fleet
-- condition, and it has to be visible in the UI while the run is still going.

create table if not exists public.alerts (
  id          uuid primary key default gen_random_uuid(),
  -- Null for fleet-wide conditions that are not tied to one run.
  campaign_id uuid references public.campaigns(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,

  kind        text not null,
  severity    text not null default 'error'
              check (severity in ('info', 'warning', 'error')),
  message     text not null,
  detail      jsonb not null default '{}'::jsonb,

  -- How many times this condition recurred while still unacknowledged. Counting
  -- beats inserting a row per occurrence: a 402 during a 100-lead run would
  -- otherwise write a hundred identical alerts and bury everything else.
  occurrences int not null default 1,

  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  acknowledged_at timestamptz
);

comment on table public.alerts is
  'Operator-visible conditions that must not degrade silently — a verifier out '
  'of credits, bad credentials, or every outbound IP cooling.';

-- One open alert per kind per campaign. Re-raising bumps the counter instead of
-- adding a row; acknowledging closes it and lets a genuinely new occurrence
-- open a fresh one.
create unique index if not exists alerts_open_unique
  on public.alerts (kind, coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where acknowledged_at is null;

create index if not exists alerts_campaign_open
  on public.alerts (campaign_id) where acknowledged_at is null;

-- ── raise_alert ──────────────────────────────────────────────────────────────
--
-- Upsert-or-bump in one statement. Workers run several jobs concurrently and a
-- read-modify-write from Node would lose occurrences under exactly the
-- conditions that produce alerts in the first place.

create or replace function public.raise_alert(
  p_kind        text,
  p_message     text,
  p_severity    text default 'error',
  p_campaign_id uuid default null,
  p_detail      jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_id      uuid;
begin
  -- Inherit ownership from the campaign so RLS shows the alert to the right
  -- user without the caller having to know who that is.
  if p_campaign_id is not null then
    select user_id into v_user_id from public.campaigns where id = p_campaign_id;
  end if;

  insert into public.alerts (kind, message, severity, campaign_id, user_id, detail)
  values (p_kind, p_message, p_severity, p_campaign_id, v_user_id, p_detail)
  on conflict (kind, coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid))
    where acknowledged_at is null
  do update set
    occurrences  = public.alerts.occurrences + 1,
    last_seen_at = now(),
    message      = excluded.message,
    detail       = excluded.detail
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.raise_alert is
  'Raise or bump an operator alert. Idempotent per (kind, campaign) while open.';

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.alerts enable row level security;

drop policy if exists "alerts: owner reads"        on public.alerts;
drop policy if exists "alerts: owner acknowledges" on public.alerts;

-- Fleet-wide alerts (no campaign, no user) are visible to any authenticated
-- user: they describe the shared infrastructure everyone's runs depend on.
create policy "alerts: owner reads" on public.alerts for select
  using (user_id = auth.uid() or user_id is null);

create policy "alerts: owner acknowledges" on public.alerts for update
  using (user_id = auth.uid() or user_id is null)
  with check (user_id = auth.uid() or user_id is null);

-- Live in the UI without a poll.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts'
  ) then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;
