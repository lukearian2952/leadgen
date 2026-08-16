-- Pipeline reliability: stale-lease claiming + a cron watchdog that reconciles
-- campaigns whose Apify webhook never arrived.
--
-- Background: once a campaign reaches current_step = 20 the ONLY thing that can
-- advance it is an inbound webhook from Apify. A dropped callback or a hung
-- actor strands the campaign in 'running' forever (one sat there for 43 days).

-- ── Track the in-flight Apify run so it can be reconciled ────────────────────

alter table campaigns
  add column if not exists apify_run_id text,
  add column if not exists apify_phase  text;

-- Partial index for the watchdog's "what is stale?" scan.
create index if not exists campaigns_active_idx
  on campaigns (updated_at)
  where status in ('running', 'pending');

-- ── Atomic step claim with a stale lease ─────────────────────────────────────
--
-- Replaces the old `.in('status', ['pending','paused'])` guard in the step
-- functions, which made Resume a no-op: the UI set status='running' before
-- calling, so the claim could never match and the step silently skipped.
--
-- A campaign already 'running' is only claimable once its lease has expired.
-- Live steps flush progress every few seconds, and the campaigns_updated_at
-- trigger refreshes updated_at on every write, so an actually-running step
-- keeps renewing its own lease and cannot be stolen.

create or replace function claim_campaign_step(
  p_campaign_id uuid,
  p_step        int,
  p_stale_after interval default '3 minutes'
)
returns setof campaigns
language sql
security definer
set search_path = public
as $$
  update campaigns c
     set status       = 'running',
         current_step = p_step,
         started_at   = coalesce(c.started_at, now())
   where c.id = p_campaign_id
     and c.status in ('pending', 'paused', 'failed', 'running')
     and (c.status <> 'running' or c.updated_at < now() - p_stale_after)
  returning c.*;
$$;

revoke all on function claim_campaign_step(uuid, int, interval) from public, anon, authenticated;
grant execute on function claim_campaign_step(uuid, int, interval) to service_role;

-- ── Watchdog schedule ────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets are read from Vault so the service key never lives in a migration.
-- Insert them once (see the note in the deploy checklist):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>',        'service_role_key');

do $$
begin
  perform cron.unschedule('campaign-watchdog');
exception when others then
  null;  -- not scheduled yet
end $$;

select cron.schedule(
  'campaign-watchdog',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/campaign-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
