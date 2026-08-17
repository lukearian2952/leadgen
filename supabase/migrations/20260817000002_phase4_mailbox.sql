-- Phase 4: mailbox conversion.
--
-- Phase 3 moved named-rate 24% → 40% and Tier A did not move at all (1 → 1).
-- Of 30 named leads the mailbox stage lost 6 mailbox_invalid, 6
-- catch_all_low_score, 5 no_mx, 2 freemail and 1 risky. The wall is no longer
-- "who runs this business" but "what address reaches them", so everything here
-- serves that.
--
-- Three things:
--   1. `domain_patterns.source` — how a pattern was learned, so a pattern
--      inferred from an address found on the site is distinguishable from one
--      confirmed by a verified send. They deserve different confidence.
--   2. A GIN index on `registry_entities.officers` for the reverse lookup:
--      "is this person, found on a website, an officer of any entity in this
--      county?" is a containment query over 22k jsonb arrays.
--   3. `leads.address_source` — where the postal address came from, since the
--      registry reverse lookup now yields one.

-- ── domain_patterns provenance ───────────────────────────────────────────────

alter table public.domain_patterns
  add column if not exists source text not null default '',
  add column if not exists discovered_addresses text[] not null default '{}';

comment on column public.domain_patterns.source is
  'How the pattern was learned: verified_send | site_crawl | mailto | gbp | serp';

-- ── registry reverse lookup ──────────────────────────────────────────────────
--
-- `officers @> '[{"first":"Uzma","last":"Iqbal"}]'` is the query. jsonb_path_ops
-- is the right opclass: it indexes only containment, which is all this asks,
-- and is substantially smaller than the default.

create index if not exists registry_entities_officers_gin
  on public.registry_entities using gin (officers jsonb_path_ops);

-- ── address provenance on the lead ───────────────────────────────────────────

alter table public.leads
  add column if not exists postal_street text not null default '',
  add column if not exists postal_city   text not null default '',
  add column if not exists postal_zip    text not null default '',
  add column if not exists address_source text not null default '';

comment on column public.leads.address_source is
  'Where the mailing address came from: google_maps | registry_reverse | registry_match';

-- ── mailbox_feedback: the closed loop ────────────────────────────────────────
--
-- Ground truth from an actual send, as opposed to a verifier's prediction. The
-- unique key on (email, outcome) is the idempotency guarantee: senders retry
-- webhooks, and the same bounce applied twice must not count twice or
-- re-promote a pattern that a later hard bounce retracted.
--
-- Not (email) alone, deliberately — an address can legitimately soft-bounce on
-- Monday and deliver on Tuesday, and both facts are worth keeping.

create table if not exists public.mailbox_feedback (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  outcome    text not null check (outcome in ('delivered','hard_bounce','soft_bounce')),
  source     text not null default '',
  domain     text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists mailbox_feedback_uniq
  on public.mailbox_feedback (email, outcome);
create index if not exists mailbox_feedback_domain
  on public.mailbox_feedback (domain);

alter table public.mailbox_feedback enable row level security;
-- Service-role only: written by the sender webhook, read by the pattern logic.
