-- ── campaigns ──────────────────────────────────────────────────
create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  niche         text not null,
  location      text not null,
  target_count  int  not null check (target_count between 1 and 500),
  status        text not null default 'pending'
                  check (status in ('pending','running','paused','completed','failed')),
  current_step  int  not null default 0,
  step1_done    int  not null default 0,
  step2_done    int  not null default 0,
  step3_done    int  not null default 0,
  step5_done    int  not null default 0,
  stat_owners   int  not null default 0,
  stat_emails   int  not null default 0,
  stat_content  int  not null default 0,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.campaigns enable row level security;
create policy "campaigns: owner only" on public.campaigns for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── leads ──────────────────────────────────────────────────────
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  business_name   text not null default '',
  short_name      text not null default '',
  phone           text not null default '',
  website         text not null default '',
  place_id        text not null default '',
  city            text not null default '',
  owner_name      text not null default '',
  owner_strategy  text not null default '',
  email           text not null default '',
  email_status    text not null default '',
  website_content text not null default '',
  step2_done      boolean not null default false,
  step3_done      boolean not null default false,
  step5_done      boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table public.leads enable row level security;
create policy "leads: campaign owner only" on public.leads for all
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and c.user_id = auth.uid()
  ));

create index leads_campaign_step2 on public.leads(campaign_id, step2_done);
create index leads_campaign_step3 on public.leads(campaign_id, step3_done);
create index leads_campaign_step5 on public.leads(campaign_id, step5_done);

-- ── campaign_logs ──────────────────────────────────────────────
create table public.campaign_logs (
  id           bigserial primary key,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  step         int  not null default 0,
  level        text not null default 'info' check (level in ('info','success','warning','error')),
  message      text not null,
  created_at   timestamptz not null default now()
);

alter table public.campaign_logs enable row level security;
create policy "logs: read own" on public.campaign_logs for select
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and c.user_id = auth.uid()
  ));
-- Edge Functions insert logs using service role key (bypasses RLS)

create index logs_campaign_created on public.campaign_logs(campaign_id, created_at desc);

-- ── updated_at trigger ─────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger campaigns_updated_at
  before update on public.campaigns
  for each row execute procedure public.set_updated_at();
