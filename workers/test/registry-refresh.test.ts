// The weekly refresh reads its scope back out of `registry_ingest_runs` rather than
// carrying its own list of niche tokens.
//
// That is the whole point of the design, and the thing worth protecting: a
// hard-coded token list here would drift from what is actually loaded, which is
// exactly the failure that made a car-wrap campaign match against a med-spa
// slice and read as a coverage ceiling rather than a scoping mistake.

import { describe, it, expect, vi } from 'vitest'
import { makeRegistryRefreshTask } from '../src/jobs/registry-refresh.js'

type Row = Record<string, unknown>

/** Minimal stand-ins for the pg Pool and graphile job context. */
function harness(ingestRows: Row[]) {
  const added: Array<{ task: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = []
  const costDetail: { value: Record<string, unknown> } = { value: {} }

  // Supabase: wrapTask's own bookkeeping rows, nothing this test cares about.
  const db = { query: vi.fn(async () => ({ rows: [] })) }

  // registry-db: where the ingest scopes now live, beside the entities they
  // describe.
  const registryDb = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('registry_ingest_runs')) return { rows: ingestRows }
      return { rows: [] }
    }),
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    helpers: {
      addJob: vi.fn(async (task: string, payload: Record<string, unknown>,
                          opts: Record<string, unknown>) => {
        added.push({ task, payload, opts })
      }),
    },
    get cost() { return { set detail(v: Record<string, unknown>) { costDetail.value = v } } },
  }

  return { db, registryDb, ctx, added, costDetail }
}

/** Call the task body directly, bypassing wrapTask's db bookkeeping. */
async function run(ingestRows: Row[], payload: Record<string, unknown> = {}) {
  const h = harness(ingestRows)
  const cost = { detail: {} as Record<string, unknown> }
  const task = makeRegistryRefreshTask({
    db: h.db as never, registryDb: h.registryDb as never, config: {} as never,
  } as never)

  // wrapTask wraps the body; invoke through it with a stub helpers/logger.
  await task(payload, {
    logger: h.ctx.logger,
    addJob: h.ctx.helpers.addJob,
    withPgClient: vi.fn(),
    job: { id: '1', attempts: 1, max_attempts: 2 },
  } as never)

  return { ...h, cost }
}

const CAR_WRAP = ['WRAP', 'VINYL', 'GRAPHIC', 'SIGN']

describe('registry:refresh', () => {
  it('re-enqueues each loaded state with the scope that state was loaded under', async () => {
    const { added } = await run([
      { state: 'CT', name_contains: CAR_WRAP, mode: null },
      { state: 'OR', name_contains: CAR_WRAP, mode: null },
    ])

    expect(added.map(a => a.task)).toEqual(['registry:ingest', 'registry:ingest'])
    expect(added.map(a => a.payload.state)).toEqual(['CT', 'OR'])
    for (const a of added) expect(a.payload.nameContains).toEqual(CAR_WRAP)
  })

  it('carries FL forward in quarterly mode rather than silently downgrading to daily', async () => {
    // `ingest` defaults to 'daily', which is five business days of filings —
    // a refresh that dropped the mode would quietly replace a whole-state slice
    // with a week of it.
    const { added } = await run([{ state: 'FL', name_contains: CAR_WRAP, mode: 'quarterly' }])
    expect(added[0].payload.mode).toBe('quarterly')
  })

  it('omits the mode entirely for states that have none', async () => {
    const { added } = await run([{ state: 'CO', name_contains: CAR_WRAP, mode: null }])
    expect(added[0].payload).not.toHaveProperty('mode')
  })

  it('staggers the states instead of starting five ingests at once', async () => {
    // Five concurrent ingests would each check the database-size ceiling
    // against a database the other four are still writing to.
    const { added } = await run([
      { state: 'CO', name_contains: CAR_WRAP, mode: null },
      { state: 'CT', name_contains: CAR_WRAP, mode: null },
      { state: 'FL', name_contains: CAR_WRAP, mode: 'quarterly' },
    ])
    const times = added.map(a => (a.opts.runAt as Date).getTime())
    expect(times[1] - times[0]).toBe(20 * 60_000)
    expect(times[2] - times[1]).toBe(20 * 60_000)
  })

  it('keys each ingest per state so a refresh cannot stack on a manual run', async () => {
    const { added } = await run([{ state: 'FL', name_contains: CAR_WRAP, mode: 'quarterly' }])
    expect(added[0].opts.jobKey).toBe('registry:ingest:FL:quarterly')
  })

  it('refreshes only the states asked for, when asked', async () => {
    const { added } = await run([
      { state: 'CO', name_contains: CAR_WRAP, mode: null },
      { state: 'CT', name_contains: CAR_WRAP, mode: null },
    ], { states: ['CT'] })
    expect(added).toHaveLength(1)
    expect(added[0].payload.state).toBe('CT')
  })

  it('does not invent a slice for a state that has never been ingested', async () => {
    // Adding a state is a deliberate act. A weekly job that started ingesting
    // new states on its own would be a surprise bill and a surprise 400 MB.
    const { added } = await run([])
    expect(added).toHaveLength(0)
  })

  it('skips a recorded run that carried no name tokens', async () => {
    // An unscoped ingest is 4.27M rows for NY. If the history has one, it is a
    // bad record rather than an instruction.
    const { added } = await run([{ state: 'NY', name_contains: [], mode: null }])
    expect(added).toHaveLength(0)
  })
})
