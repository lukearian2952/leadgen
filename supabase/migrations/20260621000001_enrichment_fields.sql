alter table public.leads
  add column if not exists owner_email  text not null default '',
  add column if not exists title        text not null default '',
  add column if not exists company_size text not null default '';
