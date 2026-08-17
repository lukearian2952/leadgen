// The Phase 3 report, computed from the run's own rows.
//
// Everything the brief asks for: the standard funnel, plus named-rate per
// source and the union, clinical_lead promotions broken out by which
// corroboration admitted them, freemail Tier-B count, the registry
// match-confidence distribution, and Verifalia spend.

import pg from 'pg'

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 3,
})

const C = process.argv[2]
if (!C) throw new Error('usage: phase3-report.ts <campaign_id> [<baseline_campaign_id>]')
const BASE = process.argv[3] ?? 'fd23a9e1-a5d9-4dd7-91a1-babcc0179e96'

const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const head = (s: string) => console.log(`\n═══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`)
const table = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return console.log('  (none)')
  const cols = Object.keys(rows[0])
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)))
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join(' │ '))
  console.log('  ' + w.map(n => '─'.repeat(n)).join('─┼─'))
  for (const r of rows) console.log('  ' + cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join(' │ '))
}

// ── funnel, against the Phase 2 baseline ─────────────────────────────────────
head('FUNNEL — Phase 3 vs Phase 2 baseline')
table(await q(`
  select case when campaign_id = $1 then 'phase3' else 'phase2' end run,
         count(*) total,
         count(*) filter (where crawl_done) crawled,
         count(*) filter (where owner_first_name <> '') named,
         round(100.0 * count(*) filter (where owner_first_name <> '') / count(*), 1) named_pct,
         count(*) filter (where tier='A') tier_a,
         count(*) filter (where tier='B') tier_b,
         count(*) filter (where tier='C') tier_c,
         count(*) filter (where tier='rejected') rejected
    from leads where campaign_id in ($1,$2)
   group by 1 order by 1 desc`, [C, BASE]))

// ── named-rate per source, and the union ─────────────────────────────────────
//
// `owner_source` is the source that WON. A lead can be named by two sources and
// only one wins, so per-source "would have named" is read from the stored
// candidate list, and the union is the count of leads any source could name.
head('NAMED-RATE PER SOURCE (the brief\'s key number)')
table(await q(`
  with cand as (
    select l.id,
           jsonb_array_elements(coalesce(l.evidence->'name_candidates','[]'::jsonb)) c
      from leads l where l.campaign_id = $1
  ), usable as (
    select id, c->>'source' source,
           (c->>'nameClass') = 'owner_grade' owner_grade
      from cand where coalesce(c->>'first','') <> ''
  )
  select source,
         count(distinct id) proposed_a_name,
         count(distinct id) filter (where owner_grade) owner_grade,
         round(100.0 * count(distinct id) / 75, 1) pct_of_75
    from usable group by 1 order by 2 desc`, [C]))

head('WHICH SOURCE ACTUALLY WON (owner_source on the final row)')
table(await q(`
  select coalesce(nullif(owner_source,''),'(none)') winning_source,
         count(*) leads,
         round(100.0*count(*)/75,1) pct
    from leads where campaign_id = $1 group by 1 order by 2 desc`, [C]))

head('UNION — any source able to name the lead')
table(await q(`
  select count(*) filter (where owner_first_name <> '') named_union,
         round(100.0*count(*) filter (where owner_first_name <> '')/count(*),1) pct,
         count(*) total
    from leads where campaign_id = $1`, [C]))

// ── clinical_lead promotions ─────────────────────────────────────────────────
head('CLINICAL_LEAD PROMOTIONS, BY CORROBORATION')
table(await q(`
  select name_class,
         count(*) leads,
         count(*) filter (where 'registry_officer' = any(corroboration)) by_registry,
         count(*) filter (where 'serp_owner' = any(corroboration)) by_serp,
         count(*) filter (where 'sole_person_ownership' = any(corroboration)) by_sole_person
    from leads
   where campaign_id = $1 and owner_first_name <> ''
   group by 1 order by 2 desc`, [C]))

head('CLINICAL LEADS FOUND BUT NOT PROMOTED (uncorroborated)')
table(await q(`
  select count(*) leads
    from leads
   where campaign_id = $1
     and owner_first_name = ''
     and evidence->'name_decision'->>'reason' = 'clinical_lead_uncorroborated'`, [C]))

// ── freemail Tier B ──────────────────────────────────────────────────────────
head('FREEMAIL TIER-B')
table(await q(`
  select count(*) leads,
         count(distinct owner_email) addresses
    from leads where campaign_id = $1 and tier_reason = 'freemail_business_verified'`, [C]))
table(await q(`
  select business_name, owner_email, email_status,
         evidence->'freemail_tier_b'->>'matched_token' matched_token,
         evidence->'freemail_tier_b'->>'mx_status' mx_status
    from leads where campaign_id = $1 and tier_reason = 'freemail_business_verified'
   order by business_name`, [C]))

// ── registry match confidence ────────────────────────────────────────────────
head('REGISTRY MATCH-CONFIDENCE DISTRIBUTION')
table(await q(`
  select width_bucket(match_confidence, 0.6, 1.0001, 4) b,
         case width_bucket(match_confidence, 0.6, 1.0001, 4)
           when 1 then '0.60–0.70' when 2 then '0.70–0.80'
           when 3 then '0.80–0.90' else '0.90–1.00' end band,
         count(*) matches,
         count(*) filter (where owner_source='registry') won_the_name
    from leads
   where campaign_id = $1 and match_confidence is not null
   group by 1,2 order by 1`, [C]))
table(await q(`
  select count(*) entities_matched,
         round(avg(match_confidence)::numeric,3) mean,
         round(min(match_confidence)::numeric,3) min,
         round(max(match_confidence)::numeric,3) max
    from leads where campaign_id = $1 and match_confidence is not null`, [C]))

// ── reject reasons ───────────────────────────────────────────────────────────
head('REJECT REASONS — Phase 3 vs Phase 2')
table(await q(`
  select coalesce(nullif(reject_reason,''),'(none)') reason,
         count(*) filter (where campaign_id = $1) phase3,
         count(*) filter (where campaign_id = $2) phase2
    from leads where campaign_id in ($1,$2)
   group by 1 having count(*) filter (where campaign_id = $1) > 0
                or count(*) filter (where campaign_id = $2) > 0
   order by 2 desc, 3 desc`, [C, BASE]))

// ── cost ─────────────────────────────────────────────────────────────────────
head('COST BY STAGE')
table(await q(`
  select stage, count(*) jobs,
         count(*) filter (where status='failed') failed,
         round(sum(cost_cents)::numeric,2) cents,
         round(avg(extract(epoch from (finished_at-started_at)))::numeric,2) avg_seconds
    from job_runs where campaign_id = $1
   group by 1 order by 4 desc nulls last`, [C]))

head('VERIFICATION SPEND AND PROVIDER')
table(await q(`
  select provider, status, count(*) checks
    from contacts where campaign_id = $1 group by 1,2 order by 3 desc`, [C]))
table(await q(`
  select round(sum(cost_cents)::numeric,2) verify_cents_total
    from job_runs where campaign_id = $1 and stage in ('enrich:lead','verify:batch')`, [C]))

head('SERP CACHE')
table(await q(`
  select count(*) cached_queries, sum(hit_count) hits,
         count(*) filter (where jsonb_array_length(results) = 0) empty_results
    from serp_cache`))

// ── Phase 4: Tier B broken out by reason ─────────────────────────────────────
head('TIER B BY REASON (the two Phase 4 concessions)')
table(await q(`
  select tier,
         coalesce(nullif(tier_reason,''),'(none)') tier_reason,
         count(*) leads
    from leads where campaign_id = $1 and tier in ('A','B')
   group by 1,2 order by 1, 3 desc`, [C]))

head('MAILBOX RECOVERY — pattern discovery')
table(await q(`
  select source, count(*) domains, count(*) filter (where catch_all) catch_all
    from domain_patterns
   where source <> '' group by 1 order by 2 desc`))
table(await q(`
  select count(*) filter (where evidence->'pattern_used' is not null
                            and evidence->>'pattern_used' <> 'null') used_a_pattern,
         count(*) filter (where tier in ('A','B')) converted,
         count(*) filter (where reject_reason = 'mailbox_invalid') still_invalid
    from leads where campaign_id = $1 and owner_first_name <> ''`, [C]))

head('MAILBOX_INVALID: Phase 4 vs Phase 3, among named leads')
table(await q(`
  select case when campaign_id = $1 then 'phase4' else 'phase3' end run,
         count(*) filter (where owner_first_name <> '') named,
         count(*) filter (where reject_reason = 'mailbox_invalid') mailbox_invalid,
         count(*) filter (where reject_reason like 'catch_all_low_score%') catch_all_lost,
         count(*) filter (where tier = 'A') tier_a,
         count(*) filter (where tier = 'B') tier_b
    from leads where campaign_id in ($1,$2) group by 1 order by 1 desc`,
  [C, process.argv[4] ?? '0419ce66-259c-4dd0-9023-070cabb09a6b']))

head('REGISTRY REVERSE LOOKUP — hit rate')
table(await q(`
  select count(*) filter (where (detail->>'reverse_checked')::int > 0) leads_with_people,
         sum((detail->>'reverse_checked')::int) people_checked,
         sum((detail->>'reverse_hits')::int) hits,
         round(100.0 * sum((detail->>'reverse_hits')::int)
               / nullif(sum((detail->>'reverse_checked')::int),0), 1) hit_rate_pct
    from job_runs
   where campaign_id = $1 and stage = 'registry:match' and status = 'success'`, [C]))
table(await q(`
  select count(*) leads_named_by_reverse
    from leads l
   where l.campaign_id = $1
     and 'registry_officer_reverse' = any(l.corroboration)`, [C]))
table(await q(`
  select count(*) leads_with_registry_address
    from leads where campaign_id = $1 and address_source = 'registry_reverse'`, [C]))

head('NAME_IN_BUSINESS_NAME PROMOTIONS')
table(await q(`
  select count(*) filter (where 'name_in_business_name' = any(corroboration)) promotions,
         count(*) filter (where 'name_in_business_name' = any(corroboration)
                            and name_class = 'clinical_lead') clinical_promoted
    from leads where campaign_id = $1 and owner_first_name <> ''`, [C]))
table(await q(`
  select business_name, owner_first_name||' '||owner_last_name person,
         name_class, array_to_string(corroboration,',') corroboration, tier
    from leads
   where campaign_id = $1 and 'name_in_business_name' = any(corroboration)
   order by business_name`, [C]))

head('ALL CORROBORATIONS FIRED')
table(await q(`
  select unnest(corroboration) corroboration, count(*) leads
    from leads where campaign_id = $1 and owner_first_name <> ''
   group by 1 order by 2 desc`, [C]))

// ── the named leads themselves ───────────────────────────────────────────────
head('EVERY NAMED LEAD')
table(await q(`
  select business_name, owner_first_name||' '||owner_last_name person,
         left(title,28) title, name_class, owner_source src,
         array_to_string(corroboration,',') corroboration,
         tier, coalesce(nullif(tier_reason,''),reject_reason) note
    from leads where campaign_id = $1 and owner_first_name <> ''
   order by tier, business_name`, [C]))

await db.end()
