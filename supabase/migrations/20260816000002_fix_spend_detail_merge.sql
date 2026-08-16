-- Fix: add_campaign_spend nulled out counters it wasn't updating.
--
-- The merge coalesced only the stored side:
--   coalesce((spend_detail ->> key)::numeric, 0) + (p_counters ->> key)::numeric
--
-- For a key present in spend_detail but absent from p_counters, the right-hand
-- operand is NULL, so the whole sum is NULL. Every call therefore erased the
-- counters it did not itself touch — the first live campaign came out as
-- {"apify_run": 1, "maps_text_search": null, "haiku_input_token": null, ...}.
-- spend_estimate_usd was unaffected (a plain numeric add), so only the
-- per-counter breakdown was lost.

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
                    coalesce((spend_detail ->> key)::numeric, 0)
                    + coalesce((p_counters ->> key)::numeric, 0)
                  )
             from jsonb_object_keys(spend_detail || p_counters) as key
         )
   where id = p_campaign_id;
$$;

revoke all on function public.add_campaign_spend(uuid, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.add_campaign_spend(uuid, jsonb, numeric) to service_role;
