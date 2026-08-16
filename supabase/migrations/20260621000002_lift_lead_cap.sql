-- Lift the 500-lead cap to support state-level scraping
alter table public.campaigns
  drop constraint if exists campaigns_target_count_check;

alter table public.campaigns
  add constraint campaigns_target_count_check check (target_count between 1 and 10000);
