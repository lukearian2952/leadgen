-- Let the UI start a v2 campaign, instead of the decommissioned v1 pipeline.
--
-- ── The problem this fixes ───────────────────────────────────────────────────
--
-- The React app's "Start Campaign" button calls the `campaigns-create` and
-- `campaign-orchestrator` Edge Functions. Both are still ACTIVE, and both drive
-- **v1**: Google Places API plus Apify actors, writing into the same `leads`
-- table the worker fleet uses. So the only button a user can press runs the
-- pipeline this entire rebuild replaced — the one that produced the 6.4% bounce
-- rate — and bills the Places API to do it.
--
-- This is the same hazard `docs/HANDOFF.md` §2 records for v1's pg_cron
-- watchdog, which "once raced v2 and scraped 100 businesses through the Places
-- API into the same table". That one was defused by leaving the cron job
-- unscheduled. This one could not be, because it is the product's front door.
--
-- ── Why an RPC and not another Edge Function ─────────────────────────────────
--
-- v2 has no HTTP surface: it is driven by rows in `graphile_worker`. The
-- browser cannot enqueue those directly and should not be able to — the schema
-- is deliberately not exposed through PostgREST, and a client that could insert
-- arbitrary jobs could run any task with any payload.
--
-- A `security definer` function is the smallest thing that closes the gap. It
-- runs as the owner, so it can reach `graphile_worker.add_job`, while the body
-- checks that the caller owns the campaign it is being asked to start. Adding a
-- ninth Edge Function would mean another deploy target for one insert.

-- ── Which discovery stage a niche needs ──────────────────────────────────────
--
-- Mirrors `resolveNicheFilter` in the worker: a niche that matches no
-- brick-and-mortar rule is treated as online/SaaS, which has no storefront and
-- so no Google Maps listing worth having. Kept deliberately small and
-- conservative — the cost of guessing "saas" wrongly is a Maps-shaped business
-- discovered by search, which mostly still works; the cost of guessing "maps"
-- wrongly is a SaaS campaign that finds medical offices.
create or replace function discovery_stage_for_niche(p_niche text)
returns text
language sql
immutable
as $$
  select case
    when p_niche ~* '\y(saas|software|platform|app|api|crm|tool|startup)\y'
     and p_niche !~* '\y(repair|installer|store|shop|clinic|salon|dealer)\y'
    then 'saas:discover'
    else 'maps:discover'
  end;
$$;

comment on function discovery_stage_for_niche(text) is
  'maps:discover for brick-and-mortar, saas:discover for online niches.';

-- ── Start a campaign on the worker fleet ─────────────────────────────────────
create or replace function start_campaign_v2(
  p_campaign_id uuid,
  -- Residential proxy allowance. The 1,000-business national run spent 1.53 GB
  -- of a 2.5 GB cap, so the default is a real ceiling rather than a formality.
  p_residential_budget_bytes bigint default 2500000000
)
returns jsonb
language plpgsql
security definer
set search_path = public, graphile_worker
as $$
declare
  v_campaign campaigns;
  v_stage    text;
  v_job_key  text;
begin
  -- Ownership, checked against the JWT rather than trusted from the argument.
  -- `security definer` bypasses RLS, so this is the only thing standing between
  -- one user and another user's campaigns.
  select * into v_campaign
    from campaigns
   where id = p_campaign_id
     and user_id = auth.uid();

  if not found then
    raise exception 'campaign % not found for this user', p_campaign_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Starting a running campaign a second time would enqueue a second discovery
  -- batch alongside a healthy one and double the spend. `job_key` below makes
  -- that idempotent anyway, but failing loudly is better than silently doing
  -- nothing the caller can observe.
  if v_campaign.status = 'running' and v_campaign.current_step > 1 then
    return jsonb_build_object(
      'started', false,
      'reason',  'already running',
      'stage',   null);
  end if;

  v_stage := discovery_stage_for_niche(v_campaign.niche);

  update campaigns
     set status                    = 'running',
         current_step              = 1,
         started_at                = coalesce(started_at, now()),
         residential_budget_bytes  = coalesce(p_residential_budget_bytes,
                                              residential_budget_bytes),
         updated_at                = now()
   where id = p_campaign_id;

  -- One discovery job per campaign. `job_key` collapses a double-click, a
  -- retry and a Resume into the same row rather than three concurrent scrapes.
  v_job_key := p_campaign_id::text || ':all:' || v_stage;

  perform graphile_worker.add_job(
    v_stage,
    json_build_object(
      'campaignId',  p_campaign_id,
      'niche',       v_campaign.niche,
      'location',    v_campaign.location,
      'targetCount', v_campaign.target_count
    ),
    max_attempts := 2,
    job_key      := v_job_key
  );

  return jsonb_build_object(
    'started', true,
    'stage',   v_stage,
    'job_key', v_job_key);
end;
$$;

comment on function start_campaign_v2(uuid, bigint) is
  'Enqueue discovery for a campaign on the v2 worker fleet. Checks auth.uid() '
  'owns the campaign; security definer so it can reach graphile_worker.';

-- `authenticated` only. `anon` must not be able to enqueue work.
revoke all on function start_campaign_v2(uuid, bigint) from public, anon;
grant execute on function start_campaign_v2(uuid, bigint) to authenticated;

-- `anon` is revoked explicitly, not just via PUBLIC: Supabase grants the anon
-- role directly through default privileges, so revoking from PUBLIC alone
-- leaves it in place. Harmless for a pure function, but the grant should say
-- what it means.
revoke all on function discovery_stage_for_niche(text) from public, anon;
grant execute on function discovery_stage_for_niche(text) to authenticated;

-- ── Pause ────────────────────────────────────────────────────────────────────
--
-- v1's Pause worked by setting `status = 'paused'` from the browser and relying
-- on the orchestrator to notice. v2 has no orchestrator loop to notice, so
-- pausing also has to remove the queued work — otherwise a "paused" campaign
-- keeps running to completion, which is the status lying about the system, the
-- failure mode HANDOFF §10.4 calls worse than a crash.
create or replace function pause_campaign_v2(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, graphile_worker
as $$
declare
  v_removed int;
begin
  if not exists (
    select 1 from campaigns where id = p_campaign_id and user_id = auth.uid()
  ) then
    raise exception 'campaign % not found for this user', p_campaign_id
      using errcode = 'insufficient_privilege';
  end if;

  update campaigns set status = 'paused', updated_at = now()
   where id = p_campaign_id;

  -- Only jobs not currently being worked. A locked job is mid-flight; killing
  -- its row would strand the worker holding it.
  with removed as (
    delete from graphile_worker._private_jobs j
     where j.payload->>'campaignId' = p_campaign_id::text
       and j.locked_at is null
    returning 1
  )
  select count(*) into v_removed from removed;

  return jsonb_build_object('paused', true, 'jobs_removed', v_removed);
end;
$$;

comment on function pause_campaign_v2(uuid) is
  'Pause a campaign and drop its queued (unlocked) jobs. In-flight jobs finish.';

revoke all on function pause_campaign_v2(uuid) from public, anon;
grant execute on function pause_campaign_v2(uuid) to authenticated;
