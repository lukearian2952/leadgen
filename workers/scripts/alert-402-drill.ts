// Fire the Verifalia 402 alert once, for real, so the banner is seen live.
//
// ── Why a drill rather than a unit test ─────────────────────────────────────
//
// The alert banner "builds and is wired" and has never once been seen with a
// live alert (HANDOFF §7.5). A banner nobody has watched render is a banner
// nobody knows renders: RLS could hide the row, the Realtime publication could
// be missing the table, `useAlerts`'s `.or(campaign_id.eq…,campaign_id.is.null)`
// could be malformed, and every one of those failures looks exactly like "no
// alerts right now".
//
// Verifalia's 402 is the condition the whole mechanism was built for — it took
// out a run's entire verification and left only a container log — and it is
// also the one condition we cannot summon on demand, because summoning it means
// spending the credit balance to zero.
//
// So this drives the real `VerifaliaProvider` against a local stub that answers
// 402. Everything downstream of the HTTP response is production code: the
// status check, `raiseCredentialAlert`, `PgAlertSink`, `raise_alert`, the row,
// the Realtime publication, and whatever the UI does with it. Only the upstream
// answer is faked, which is the one part that is not ours.
//
// The alert is raised against a throwaway campaign so nothing real is annotated,
// and `--clear` acknowledges it and deletes the campaign afterwards.
//
// Usage:
//   npx tsx scripts/alert-402-drill.ts          # raise it
//   npx tsx scripts/alert-402-drill.ts --clear  # acknowledge and clean up

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appPool } from './_db.js'
import { VerifaliaProvider } from '../src/verify/verifalia.js'
import { PgAlertSink, ALERT_VERIFALIA_PAYMENT } from '../src/verify/alerts.js'

const MARKER = 'alert-402-drill'
const db = appPool(2)

const logger = {
  info: (m: string, d?: unknown) => console.log('  info', m, d ?? ''),
  warn: (m: string, d?: unknown) => console.log('  warn', m, d ?? ''),
  error: (m: string, e?: unknown) => console.log('  error', m, e ?? ''),
  debug: () => {},
  child() { return this },
} as never

async function findCampaign(): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from campaigns where spend_detail->>'run_label' = $1
      order by created_at desc limit 1`, [MARKER])
  return rows[0]?.id ?? null
}

async function raise(): Promise<void> {
  let campaignId = await findCampaign()
  if (!campaignId) {
    const { rows: [u] } = await db.query<{ user_id: string }>(
      `select user_id from campaigns order by created_at desc limit 1`)
    const { rows: [c] } = await db.query<{ id: string }>(
      `insert into campaigns (user_id, niche, location, target_count, status, current_step, spend_detail)
       values ($1,'alert drill','n/a',1,'paused',0, jsonb_build_object('run_label',$2::text))
       returning id`, [u.user_id, MARKER])
    campaignId = c.id
  }
  console.log(`drill campaign ${campaignId}`)

  // ── the stub ──────────────────────────────────────────────────────────────
  const server = createServer((_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ help: 'stubbed 402 — alert drill, not a real Verifalia response' }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  console.log(`stub answering 402 on 127.0.0.1:${port}`)

  const sink = new PgAlertSink(db, logger)
  const provider = new VerifaliaProvider(
    'drill', 'drill', logger, 5_000, sink, campaignId,
    `http://127.0.0.1:${port}/v2.5`)

  // Real provider, real 402 handling, real alert sink.
  const results = await provider.verify(['drill@example.com', 'drill2@example.com'])
  server.close()

  console.log(`provider returned ${results.length} results, statuses: ` +
              `${[...new Set(results.map(r => r.status))].join(',') || '(none)'}`)

  // ── what the UI will select ───────────────────────────────────────────────
  //
  // Deliberately the same predicate as useAlerts: open only, this campaign or
  // fleet-wide. If this returns the row, the banner has a row to render.
  const { rows } = await db.query(
    `select id, kind, severity, message, campaign_id, detail, first_seen_at, last_seen_at, occurrences
       from alerts
      where acknowledged_at is null
        and (campaign_id = $1 or campaign_id is null)
      order by last_seen_at desc`, [campaignId])

  console.log(`\nopen alerts useAlerts(${campaignId?.slice(0, 8)}) would return: ${rows.length}`)
  for (const r of rows) console.log(' ', JSON.stringify(r))

  const hit = rows.find(r => (r as { kind: string }).kind === ALERT_VERIFALIA_PAYMENT)
  console.log(hit
    ? `\nOK — ${ALERT_VERIFALIA_PAYMENT} is open and visible to the banner.`
    : `\nFAIL — the 402 did not produce an open ${ALERT_VERIFALIA_PAYMENT} alert.`)

  const { rows: [pub] } = await db.query<{ n: string }>(
    `select count(*) n from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts'`)
  console.log(pub.n === '0'
    ? 'WARNING: alerts is NOT in the supabase_realtime publication — the banner ' +
      'will not appear until a reload.'
    : 'alerts is in the Realtime publication — the banner appears without a reload.')
}

async function clear(): Promise<void> {
  const campaignId = await findCampaign()
  const { rowCount: acked } = await db.query(
    `update alerts set acknowledged_at = now()
      where acknowledged_at is null and kind = $1
        and (campaign_id = $2 or ($2 is null and campaign_id is null))`,
    [ALERT_VERIFALIA_PAYMENT, campaignId])
  console.log(`acknowledged ${acked} alert(s)`)
  if (campaignId) {
    await db.query(`delete from campaigns where id = $1`, [campaignId])
    console.log(`deleted drill campaign ${campaignId}`)
  }
}

const run = process.argv.includes('--clear') ? clear : raise
run().then(() => db.end()).catch(err => { console.error(err); process.exit(1) })
