-- v2 Phase 1: the worker fleet's own tables.
--
-- graphile-worker installs its `graphile_worker` schema through its own
-- migrator (it runs at worker boot), so nothing here touches the queue itself.
-- This migration adds the tables *around* the queue: what ran, what died, what
-- each source cost, and which verifier IPs are currently in the sin bin.
--
-- Everything is additive. No v1 column is dropped — v1 stays deployable until
-- the v2 pipeline has been proven on the same benchmark (see docs/MIGRATION.md).

create extension if not exists pg_trgm;

-- ── job_runs ─────────────────────────────────────────────────────────────────
--
-- One row per job attempt. graphile-worker keeps its own internal job table but
-- deletes rows on success, so it cannot answer "what did this campaign actually
-- do, and what did it cost?". This can.

create table if not exists public.job_runs (
  id           bigserial primary key,
  campaign_id  uuid references public.campaigns(id) on delete cascade,
  lead_id      uuid references public.leads(id) on delete cascade,
  stage        text not null,
  status       text not null default 'running'
                 check (status in ('running','success','failed','skipped')),
  attempt      int  not null default 1,
  error        text,
  -- Free-form per-stage detail: counts, provider verdicts, proxy bytes.
  detail       jsonb not null default '{}'::jsonb,
  cost_cents   numeric(12,4) not null default 0,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists job_runs_campaign_stage
  on public.job_runs (campaign_id, stage, started_at desc);

create index if not exists job_runs_lead
  on public.job_runs (lead_id) where lead_id is not null;

-- The jobs dashboard's "error rate" panel reads this.
create index if not exists job_runs_failed
  on public.job_runs (started_at desc) where status = 'failed';

-- ── dead_letter ──────────────────────────────────────────────────────────────
--
-- A job that exhausted its retries. Kept with its full payload so the UI can
-- requeue it verbatim rather than reconstructing the arguments.

create table if not exists public.dead_letter (
  id           bigserial primary key,
  campaign_id  uuid references public.campaigns(id) on delete cascade,
  lead_id      uuid references public.leads(id) on delete cascade,
  stage        text not null,
  job_key      text,
  payload      jsonb not null default '{}'::jsonb,
  error        text not null default '',
  attempts     int  not null default 0,
  created_at   timestamptz not null default now(),
  requeued_at  timestamptz
);

create index if not exists dead_letter_campaign
  on public.dead_letter (campaign_id, created_at desc)
  where requeued_at is null;

-- ── source_costs ─────────────────────────────────────────────────────────────
--
-- Yield and spend per source per stage, which is what the phase reports are
-- built from. Kept separate from campaigns.spend_detail because we now need
-- "what did the registry source contribute vs the crawl", not just a total.

create table if not exists public.source_costs (
  id           bigserial primary key,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  source       text not null,
  stage        text not null,
  units        int  not null default 0,
  -- Proxy bytes are the dominant variable cost on residential egress.
  proxy_bytes  bigint not null default 0,
  llm_input_tokens  bigint not null default 0,
  llm_output_tokens bigint not null default 0,
  cost_cents   numeric(12,4) not null default 0,
  updated_at   timestamptz not null default now(),
  unique (campaign_id, source, stage)
);

-- Accumulate atomically: workers run in parallel replicas, so a
-- read-modify-write from Node would lose updates the same way v1's
-- spend_detail did before add_campaign_spend existed.
create or replace function public.add_source_cost(
  p_campaign_id uuid,
  p_source      text,
  p_stage       text,
  p_units       int,
  p_proxy_bytes bigint,
  p_llm_in      bigint,
  p_llm_out     bigint,
  p_cost_cents  numeric
) returns void
language sql
security definer
set search_path = public
as $$
  insert into source_costs as sc
    (campaign_id, source, stage, units, proxy_bytes,
     llm_input_tokens, llm_output_tokens, cost_cents, updated_at)
  values
    (p_campaign_id, p_source, p_stage, coalesce(p_units,0), coalesce(p_proxy_bytes,0),
     coalesce(p_llm_in,0), coalesce(p_llm_out,0), coalesce(p_cost_cents,0), now())
  on conflict (campaign_id, source, stage) do update
    set units             = sc.units + excluded.units,
        proxy_bytes       = sc.proxy_bytes + excluded.proxy_bytes,
        llm_input_tokens  = sc.llm_input_tokens + excluded.llm_input_tokens,
        llm_output_tokens = sc.llm_output_tokens + excluded.llm_output_tokens,
        cost_cents        = sc.cost_cents + excluded.cost_cents,
        updated_at        = now();
$$;

revoke all on function public.add_source_cost(uuid,text,text,int,bigint,bigint,bigint,numeric)
  from public, anon, authenticated;
grant execute on function public.add_source_cost(uuid,text,text,int,bigint,bigint,bigint,numeric)
  to service_role;

-- ── verifier_ip_state ────────────────────────────────────────────────────────
--
-- Which outbound IPs verify-svc may currently use.
--
-- An IP that trips a 4xx block from a big mailbox provider stays blocked for
-- hours; hammering it again extends the block and risks the IP being listed.
-- The cooldown is therefore persisted rather than held in verify-svc memory —
-- a container restart must not un-cool an IP.

create table if not exists public.verifier_ip_state (
  ip            inet primary key,
  state         text not null default 'active' check (state in ('active','cooling','disabled')),
  cooling_until timestamptz,
  last_reason   text not null default '',
  -- Rolling counters, reset by verify-svc each hour.
  checks_hour        int not null default 0,
  checks_hour_window timestamptz not null default date_trunc('hour', now()),
  blocks_seen        int not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table public.verifier_ip_state is
  'Outbound IP health for verify-svc. cooling_until is authoritative; verify-svc '
  'refuses to dial from an IP whose cooling_until is in the future.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Same per-user model as the existing tables: a user sees rows belonging to
-- their own campaigns. Workers use the service role and bypass all of this.

alter table public.job_runs         enable row level security;
alter table public.dead_letter      enable row level security;
alter table public.source_costs     enable row level security;
alter table public.verifier_ip_state enable row level security;

-- Postgres has no `create policy if not exists`, and the rest of this migration
-- is re-runnable, so drop first rather than leaving a half-idempotent file that
-- fails on the second apply.
drop policy if exists "job_runs: campaign owner"     on public.job_runs;
drop policy if exists "dead_letter: campaign owner"  on public.dead_letter;
drop policy if exists "source_costs: campaign owner" on public.source_costs;

create policy "job_runs: campaign owner" on public.job_runs for select
  using (exists (select 1 from public.campaigns c
                 where c.id = campaign_id and c.user_id = auth.uid()));

create policy "dead_letter: campaign owner" on public.dead_letter for select
  using (exists (select 1 from public.campaigns c
                 where c.id = campaign_id and c.user_id = auth.uid()));

create policy "source_costs: campaign owner" on public.source_costs for select
  using (exists (select 1 from public.campaigns c
                 where c.id = campaign_id and c.user_id = auth.uid()));

-- IP health is operator-wide, not per-campaign. No authenticated policy is
-- created, so only the service role can read it; the UI reads it through an
-- edge function rather than directly.

-- ── Realtime ─────────────────────────────────────────────────────────────────
--
-- The jobs dashboard and the dead-letter view are live. `alter publication ...
-- add table` errors if the table is already a member, so guard it.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_runs'
  ) then
    alter publication supabase_realtime add table public.job_runs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dead_letter'
  ) then
    alter publication supabase_realtime add table public.dead_letter;
  end if;
end $$;
