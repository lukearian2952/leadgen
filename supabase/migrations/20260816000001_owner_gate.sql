-- Owner-gate rework.
--
-- The pipeline previously exported every row it scraped. On a 468-lead run that
-- meant 85% with no first name, 43% role inboxes, 15 placeholder addresses and a
-- 6.4% bounce rate. From here a lead is only exportable if we can name a human,
-- reach them at a verified-deliverable mailbox, and prove the business is the
-- right type in the right place. Everything else is kept, but in a rejected
-- bucket with a reason — never in the main CSV.

-- ── leads: provenance for the gate ───────────────────────────────────────────

alter table public.leads
  -- Split identity. `owner_name` stays as the raw full string for debugging;
  -- the gate reads owner_first_name, which is a single token by construction.
  add column if not exists owner_first_name text    not null default '',
  add column if not exists owner_last_name  text    not null default '',
  add column if not exists is_doctor        boolean not null default false,
  add column if not exists owner_source     text    not null default '',

  -- Place Details facts used by gate rules 3-5.
  add column if not exists state            text    not null default '',
  add column if not exists country          text    not null default '',
  add column if not exists formatted_address text   not null default '',
  add column if not exists place_types      text[]  not null default '{}',
  add column if not exists rating_count     int     not null default 0,
  add column if not exists business_status  text    not null default '',
  add column if not exists editorial_summary text   not null default '',

  -- Deliverability evidence. mx_ok is null until checked so "unchecked" and
  -- "checked, no MX" stay distinguishable.
  add column if not exists mx_ok            boolean,
  add column if not exists domain_catch_all boolean,
  add column if not exists email_verifalia_status text not null default '',

  -- Stage bookkeeping.
  add column if not exists owner_lookup_done boolean not null default false,
  add column if not exists pending_verify    boolean not null default false,
  add column if not exists verify_attempts   int     not null default 0,

  -- Gate outcome.
  add column if not exists gate_passed   boolean not null default false,
  add column if not exists reject_reason text    not null default '';

-- The owner-lookup stage pulls its work batch through this.
create index if not exists leads_campaign_owner_lookup
  on public.leads (campaign_id, owner_lookup_done);

-- Export and stats split on this.
create index if not exists leads_campaign_gate
  on public.leads (campaign_id, gate_passed);

-- Watchdog retries ride this partial index.
create index if not exists leads_pending_verify
  on public.leads (campaign_id)
  where pending_verify;

-- ── campaigns: yield + spend ─────────────────────────────────────────────────

alter table public.campaigns
  add column if not exists stat_owner_ready  int  not null default 0,
  add column if not exists stat_rejected     int  not null default 0,
  add column if not exists stat_dropped_step1 int not null default 0,
  add column if not exists spend_estimate_usd numeric(10,4) not null default 0,
  add column if not exists spend_detail       jsonb not null default '{}'::jsonb;

-- `completed_low_yield` is a terminal success state that the UI must warn on:
-- the run worked, but fewer than 25% of scraped businesses produced a mailable
-- owner, so the list is not safe to load into a sender.
alter table public.campaigns
  drop constraint if exists campaigns_status_check;

alter table public.campaigns
  add constraint campaigns_status_check check (status in (
    'pending', 'running', 'paused', 'completed', 'failed', 'completed_low_yield'
  ));

-- ── spend accounting helper ──────────────────────────────────────────────────
--
-- Called from several edge functions concurrently (owner-lookup self-chains and
-- runs leads in parallel), so it has to be an atomic read-modify-write rather
-- than a select-then-update from Deno.

create or replace function public.add_campaign_spend(
  p_campaign_id uuid,
  p_counters    jsonb,
  p_usd         numeric
)
returns void
language sql
security definer
set search_path = public
as $$
  update campaigns
     set spend_estimate_usd = spend_estimate_usd + p_usd,
         spend_detail = (
           select jsonb_object_agg(
                    key,
                    coalesce((spend_detail ->> key)::numeric, 0) + (p_counters ->> key)::numeric
                  )
             from jsonb_object_keys(spend_detail || p_counters) as key
         )
   where id = p_campaign_id;
$$;

revoke all on function public.add_campaign_spend(uuid, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.add_campaign_spend(uuid, jsonb, numeric) to service_role;
