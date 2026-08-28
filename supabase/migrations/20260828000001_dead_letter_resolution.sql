-- Give a dead letter a way to be closed out with a reason.
--
-- `requeued_at` was the only disposition the table had, and nothing ever set it
-- — the requeue path is still unbuilt (HANDOFF §7.5). That left the three rows
-- in this table permanently indistinguishable from three live faults, which is
-- the same problem as an alert nobody can clear: the count stops meaning
-- anything and people stop reading it.
--
-- A dead letter can end three ways now:
--
--   requeued_at set          re-enqueued, outcome tracked by the new job
--   resolution set           closed deliberately, with the reason recorded
--   both null                still outstanding, and someone should look
--
-- Rows are resolved rather than deleted. The payload and error of a job that
-- died are the only record that it died, and "why did we decide this did not
-- matter" is exactly the thing that is expensive to reconstruct later.

alter table public.dead_letter
  add column if not exists resolution  text,
  add column if not exists resolved_at timestamptz;

-- "Outstanding" now means neither requeued nor resolved. The old index only
-- knew about requeues, so a resolved row would still have looked open to
-- anything reading through it.
drop index if exists public.dead_letter_campaign;
create index if not exists dead_letter_open
  on public.dead_letter (campaign_id, created_at desc)
  where requeued_at is null and resolution is null;
