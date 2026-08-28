// The Monday summary, written to docs/REPORTS/weekly/.
//
// ── Why a file rather than a dashboard ──────────────────────────────────────
//
// The dashboards answer "what is happening now". Nothing answered "what changed
// this week", and that is the question that catches slow problems: registry-db
// creeping toward its ceiling, the Verifalia balance drifting down, a dead
// letter nobody triaged, an alert that has been open for six days.
//
// It is a committed file because the point is the *diff*. A dashboard showing
// 280 credits tells you less than two files a week apart showing 883 → 280.
//
// Everything here is read-only. It changes nothing and can be run at any time.
//
// Usage:
//   npx tsx scripts/weekly-report.ts             # write docs/REPORTS/weekly/YYYY-MM-DD.md
//   npx tsx scripts/weekly-report.ts --stdout    # print instead

import { writeFileSync, mkdirSync } from 'node:fs'
import { appPool, registryPool } from './_db.js'

const toStdout = process.argv.includes('--stdout')
// Inside the container `/opt/leadgen/docs` is not mounted, so the default
// writes to the mounted scratch and the cron moves it. WEEKLY_OUT_DIR overrides
// for a local run.
const OUT_DIR = process.env.WEEKLY_OUT_DIR ?? '/scratch/weekly'

const db = appPool(2)

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** Things a human has to look at. Empty is the good case. */
const attention: string[] = []

async function inventory(): Promise<string> {
  const { rows } = await db.query<{
    niche: string; businesses: string; a: string; b: string; c: string; sendable: string
  }>(`
    with r as (
      select coalesce(l.business_id::text, l.place_id, lower(l.website), l.id::text) bkey,
             lower(c.niche) niche,
             max(case l.tier when 'A' then 4 when 'B' then 3 when 'C' then 2 else 1 end) t
        from leads l join campaigns c on c.id = l.campaign_id
       where l.tier is not null and l.tier <> '' group by 1,2)
    select niche, count(*) businesses,
           count(*) filter (where t=4) a, count(*) filter (where t=3) b,
           count(*) filter (where t=2) c, count(*) filter (where t>=3) sendable
      from r group by 1 order by 2 desc`)

  // The total is computed globally rather than by summing the rows above: a
  // business discovered under two niches (car wrap and vehicle wrap overlap by
  // three) appears in both, and summing would report 1,411 businesses where
  // there are 1,395.
  const { rows: [tot] } = await db.query<{ businesses: string; sendable: string }>(`
    with r as (
      select coalesce(l.business_id::text, l.place_id, lower(l.website), l.id::text) bkey,
             max(case l.tier when 'A' then 4 when 'B' then 3 when 'C' then 2 else 1 end) t
        from leads l where l.tier is not null and l.tier <> '' group by 1)
    select count(*) businesses, count(*) filter (where t>=3) sendable from r`)

  let out = '| niche | businesses | Tier A | Tier B | Tier C | sendable | rate |\n'
  out += '|---|---|---|---|---|---|---|\n'
  for (const r of rows) {
    const biz = Number(r.businesses), snd = Number(r.sendable)
    out += `| ${r.niche} | ${biz} | ${r.a} | ${r.b} | ${r.c} | **${snd}** | ${pct(snd, biz)} |\n`
  }
  const tb = Number(tot.businesses), ts = Number(tot.sendable)
  out += `| **total (deduped)** | **${tb}** | | | | **${ts}** | **${pct(ts, tb)}** |\n`
  return out
}

async function spend(): Promise<string> {
  const { rows: [all] } = await db.query<{ cents: string; runs: string }>(
    `select coalesce(sum(cost_cents),0) cents, count(*) runs from job_runs`)
  const { rows: [week] } = await db.query<{ cents: string; runs: string }>(
    `select coalesce(sum(cost_cents),0) cents, count(*) runs
       from job_runs where started_at > now() - interval '7 days'`)
  const { rows: sources } = await db.query<{ source: string; cents: string }>(
    `select source, coalesce(sum(cost_cents),0) cents from source_costs
      group by 1 having sum(cost_cents) > 0 order by 2 desc`)

  let out = `**${money(Number(all.cents))}** all time over ${all.runs} job runs; ` +
            `**${money(Number(week.cents))}** in the last 7 days over ${week.runs}.\n\n`
  out += '| source | all-time |\n|---|---|\n'
  for (const s of sources) out += `| ${s.source} | ${money(Number(s.cents))} |\n`
  return out
}

async function activity(): Promise<string> {
  const { rows } = await db.query<{ status: string; n: string }>(
    `select status, count(*) n from campaigns
      where created_at > now() - interval '7 days' group by 1 order by 2 desc`)
  if (!rows.length) return '_No campaigns created this week._\n'
  return rows.map(r => `- ${r.n} × \`${r.status}\``).join('\n') + '\n'
}

async function health(): Promise<string> {
  const { rows: [q] } = await db.query<{ n: string }>(
    `select count(*) n from graphile_worker._private_jobs`)
  const { rows: fails } = await db.query<{ stage: string; n: string }>(
    `select stage, count(*) n from job_runs
      where status <> 'success' and started_at > now() - interval '7 days'
      group by 1 order by 2 desc`)
  const { rows: [dl] } = await db.query<{ n: string }>(
    `select count(*) n from dead_letter
      where requeued_at is null and resolution is null`)
  const { rows: alerts } = await db.query<{ kind: string; n: string; oldest: string }>(
    `select kind, count(*) n, min(first_seen_at)::date::text oldest from alerts
      where acknowledged_at is null group by 1 order by 2 desc`)

  // Same predicate the reconcile monitor uses. A tiered row nothing verified is
  // a bug, not a result — 10% of Tier C was in this state on 2026-08-28.
  const { rows: [unver] } = await db.query<{ n: string }>(
    `select count(*) n from leads l
      where l.tier in ('A','B','C')
        and not exists (
          select 1 from job_runs j
           where j.lead_id = l.id and j.stage = 'enrich:lead'
             and (coalesce((j.detail->>'verifalia_checks')::int,0)
                + coalesce((j.detail->>'verify_svc_checks')::int,0)) > 0)`)

  if (Number(dl.n) > 0) attention.push(`${dl.n} unresolved dead letter(s) — triage or resolve with a reason`)
  if (alerts.length) attention.push(`${alerts.length} open alert kind(s): ${alerts.map(a => a.kind).join(', ')}`)
  if (Number(unver.n) > 0) attention.push(`${unver.n} tiered leads never verified — re-run enrich:lead before quoting yield`)
  if (fails.length) attention.push(`${fails.reduce((s, f) => s + Number(f.n), 0)} failed jobs in the last 7 days`)

  let out = `- queue depth: **${q.n}**\n`
  out += `- failed jobs (7d): ${fails.length ? fails.map(f => `${f.stage} ${f.n}`).join(', ') : '**none**'}\n`
  out += `- outstanding dead letters: **${dl.n}**\n`
  out += `- tiered-but-never-verified leads: **${unver.n}**\n`
  out += `- open alerts: ${alerts.length
    ? alerts.map(a => `\`${a.kind}\` ×${a.n} (since ${a.oldest})`).join(', ')
    : '**none**'}\n`
  return out
}

async function registry(): Promise<string> {
  let rdb
  try { rdb = registryPool(1) } catch { return '_registry-db not reachable from here._\n' }
  try {
    const { rows } = await rdb.query<{
      state: string; whole_state: boolean; mode: string | null
      written: string; complete: boolean; finished_at: string
    }>(`select state, whole_state, mode, written, complete,
               finished_at::date::text finished_at
          from registry_ingest_runs order by written desc`)
    const { rows: [size] } = await rdb.query<{ mb: string }>(
      `select round(pg_database_size(current_database())/1024.0/1024.0) mb`)

    const mb = Number(size.mb)
    const capMb = Number(process.env.REGISTRY_MAX_DB_MB ?? 20000)
    if (mb > capMb * 0.85) attention.push(`registry-db is ${mb} MB of a ${capMb} MB ceiling`)

    let out = `registry-db: **${mb} MB** of ${capMb} MB ceiling (${pct(mb, capMb)})\n\n`
    out += '| state | scope | rows | last ingest | complete |\n|---|---|---|---|---|\n'
    for (const r of rows) {
      const scope = r.whole_state ? `**whole**${r.mode ? ` (${r.mode})` : ''}` : 'niche-scoped'
      if (!r.complete) attention.push(`${r.state} ingest stopped early (disk ceiling) — coverage is partial`)
      out += `| ${r.state} | ${scope} | ${Number(r.written).toLocaleString()} | ${r.finished_at} | ${r.complete ? 'yes' : '**no**'} |\n`
    }

    // A refresh that has not run in over 8 days means the Sunday cron is not firing.
    const newest = rows.map(r => Date.parse(r.finished_at)).sort((a, b) => b - a)[0]
    if (newest && Date.now() - newest > 8 * 864e5) {
      attention.push('no registry ingest in over 8 days — the Sunday refresh may not be firing')
    }
    return out
  } finally {
    await rdb.end().catch(() => {})
  }
}

async function verification(): Promise<string> {
  const user = process.env.VERIFALIA_USERNAME ?? ''
  const pass = process.env.VERIFALIA_PASSWORD ?? ''
  if (!user) return '_Verifalia credentials not available to this script._\n'
  try {
    const res = await fetch('https://api.verifalia.com/v2.6/credits/balance', {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return `_Verifalia balance check returned HTTP ${res.status}._\n`
    const body = await res.json() as { creditPacks?: number }
    const credits = Number(body.creditPacks ?? 0)

    // ~6 checks per named lead, so this is "how many named leads can still be
    // judged" rather than an abstract number.
    const leads = Math.floor(credits / 6)
    if (credits < 500) {
      attention.push(`Verifalia is at ${credits} credits (~${leads} more named leads). ` +
                     `Top up before the next campaign — with none, nothing reaches Tier A`)
    }
    return `**${credits.toLocaleString()}** credits — roughly **${leads}** more named ` +
           `leads at ~6 checks each.\n`
  } catch (err) {
    return `_Verifalia balance check failed: ${(err as Error).message}._\n`
  }
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)

  const [inv, sp, act, hl, reg, ver] = [
    await inventory(), await spend(), await activity(),
    await health(), await registry(), await verification(),
  ]

  const md = `# Weekly report — ${today}

Generated by \`scripts/weekly-report.ts\`. Read-only.

## Needs a human

${attention.length ? attention.map(a => `- **${a}**`).join('\n') : '_Nothing._'}

## Inventory

${inv}
Tier B is sendable **with a caveat** — a named owner on a catch-all domain, or an
owner-named freemail address. Segment it away from Tier A in any send.

## Spend

${sp}
## Campaigns this week

${act}
## Fleet and queue

${hl}
## Registry

${reg}
## Verification

${ver}
---

*Alerts are explained in \`docs/OPERATIONS.md\` §6. If something here is unclear
a week from now, fix the report rather than remembering the explanation.*
`

  if (toStdout) { console.log(md); return }
  mkdirSync(OUT_DIR, { recursive: true })
  const path = `${OUT_DIR}/${today}.md`
  writeFileSync(path, md)
  console.log(`wrote ${path}`)
  if (attention.length) {
    console.log(`\n${attention.length} item(s) need a human:`)
    for (const a of attention) console.log(`  - ${a}`)
  }
}

main().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
