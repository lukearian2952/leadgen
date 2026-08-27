-- The registries move out of Supabase, so the foreign key into them cannot stay.
--
-- ── What happened ────────────────────────────────────────────────────────────
--
-- `registry_entities` and `zip_county` now live in **registry-db**, a local
-- Postgres beside the workers. Supabase is on the free plan — 500 MB, and a
-- project that reaches it goes read-only, taking the whole fleet down rather
-- than one job — and the registry was 238 MB of a 276 MB database, and the only
-- table that grows without bound.
--
-- `leads.registry_entity_id` referenced `registry_entities(id)`. With the
-- entities in another database that constraint can never be satisfied: the
-- matcher finds an entity in registry-db, writes its UUID to the lead, and
-- Postgres rejects the write because no such row exists locally.
--
-- This was found by running one `registry:match` against the new database
-- *before* dropping the old copy, which is the only reason it is a migration
-- rather than an outage.
--
-- ── What replaces it ─────────────────────────────────────────────────────────
--
-- Nothing. The column stays and keeps holding the matched entity's id; it is
-- now a soft reference across a database boundary, the same way `place_id`
-- refers to a Google record we do not host. What is lost is `on delete set
-- null`: deleting an entity in registry-db no longer nulls the lead's pointer,
-- so a `registry_entity_id` may outlive the row it names.
--
-- That is acceptable and worth stating. The id is provenance — evidence of
-- which filing produced a name — not a join key. Nothing reads it back to fetch
-- the entity; `registry:match` re-derives the match from scratch on every run,
-- and the officer it chose is already copied onto the lead.

alter table public.leads
  drop constraint if exists leads_registry_entity_id_fkey;

comment on column public.leads.registry_entity_id is
  'registry_entities.id in registry-db (a different database). Provenance only: '
  'not a join key, not enforced, and may outlive the row it names.';
