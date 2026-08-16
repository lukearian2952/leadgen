-- Support async Verifalia polling in step3
alter table public.leads
  add column verifalia_job_url  text,
  add column verifalia_patterns jsonb;

create index leads_campaign_verifalia on public.leads(campaign_id, verifalia_job_url)
  where verifalia_job_url is not null;
