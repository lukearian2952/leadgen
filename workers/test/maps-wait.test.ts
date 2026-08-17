import { mapsWaitMs } from '../src/jobs/maps-discover.js'
// gosom reports a job `ok` while it is still scraping, and `/download` returns
// zero bytes at that moment. The old wait trusted the status, downloaded
// nothing, and reported `returned: 0` for a run that had actually found the
// right businesses — the defect that left Phase 2 with no discovery output.

import { describe, it, expect, vi } from 'vitest'
import { MapsSource } from '../src/sources/maps.js'
import { Logger } from '../src/logger.js'

const silent = new Logger('error')

/** A MapsSource with scripted status/download responses. */
function scripted(steps: Array<{ status: string; body: string }>) {
  const source = new MapsSource('http://scraper.test', silent)
  let i = 0
  const seen: string[] = []

  vi.spyOn(source, 'status').mockImplementation(async () => {
    const step = steps[Math.min(i, steps.length - 1)]
    seen.push(step.status)
    return step.status
  })
  vi.spyOn(source, 'rawResults').mockImplementation(async () => {
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    return step.body
  })

  return { source, seen }
}

describe('maps job polling', () => {
  it('keeps waiting while the status is ok but the download is empty', async () => {
    const { source } = scripted([
      { status: 'ok', body: '' },
      { status: 'ok', body: '' },
      { status: 'ok', body: 'name,phone\nNu Med,123\n' },
    ])

    const result = await source.waitFor('job-1', 10_000, 1)

    expect(result.status).toBe('ok')
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.body).toContain('Nu Med')
  })

  it('reports ok_but_empty when the payload never arrives before the cap', async () => {
    const { source } = scripted([{ status: 'ok', body: '' }])

    const result = await source.waitFor('job-2', 30, 1)

    // Distinct from `timeout`: the scraper claimed to finish, so the two need
    // different responses and must not be conflated.
    expect(result.status).toBe('ok_but_empty')
    expect(result.bytes).toBe(0)
  })

  it('returns immediately on failure without downloading', async () => {
    const { source } = scripted([{ status: 'failed', body: '' }])
    const result = await source.waitFor('job-3', 10_000, 1)
    expect(result.status).toBe('failed')
  })

  it('treats whitespace-only downloads as empty', async () => {
    const { source } = scripted([{ status: 'ok', body: '  \n \n' }])
    const result = await source.waitFor('job-4', 30, 1)
    expect(result.status).toBe('ok_but_empty')
  })

  it('reports timeout when the job never completes', async () => {
    const { source } = scripted([{ status: 'working', body: '' }])
    const result = await source.waitFor('job-5', 30, 1)
    expect(result.status).toBe('timeout')
  })
})

describe('mapsWaitMs — the cap that dead-lettered a good scrape', () => {
  it('keeps the brief\'s 20 minutes for a Long Island-sized run', () => {
    // 30 cities x 30s = 15 min, floored to the original 20.
    expect(mapsWaitMs(30, {})).toBe(20 * 60_000)
  })

  it('scales past 20 minutes for a statewide run', () => {
    // 48 cities was still `working` at the 20-minute cap and dead-lettered on
    // its final attempt with a healthy scrape running underneath it.
    expect(mapsWaitMs(48, {})).toBe(24 * 60_000)
    expect(mapsWaitMs(48, {})).toBeGreaterThan(20 * 60_000)
  })

  it('ceilings at 45 minutes', () => {
    expect(mapsWaitMs(500, {})).toBe(45 * 60_000)
  })

  it('lets MAPS_WAIT_MINUTES override, including past the ceiling', () => {
    expect(mapsWaitMs(30, { MAPS_WAIT_MINUTES: '5' })).toBe(5 * 60_000)
    expect(mapsWaitMs(30, { MAPS_WAIT_MINUTES: '90' })).toBe(90 * 60_000)
  })

  it('ignores a non-numeric or non-positive override', () => {
    expect(mapsWaitMs(30, { MAPS_WAIT_MINUTES: 'soon' })).toBe(20 * 60_000)
    expect(mapsWaitMs(30, { MAPS_WAIT_MINUTES: '0' })).toBe(20 * 60_000)
  })
})

describe('stall detection needs a startup grace', () => {
  // The first national batch was killed after five minutes of ordinary
  // warm-up: gosom queues every query and drives a browser through them before
  // writing anything, so "no growth" from t=0 is the normal state, not a stall.
  it('does not call an empty-but-young job stalled', async () => {
    let polls = 0
    const src = new MapsSource('http://scraper', silentLogger())
    ;(src as any).status = async () => 'working'
    ;(src as any).rawResults = async () => { polls++; return '' }

    // stallMs 50ms, startup grace 400ms: an empty job must survive past stallMs.
    const out = await src.waitFor('j', 300, 10, 50, 400)
    expect(out.status).toBe('timeout')      // hit the hard backstop, not stalled
    expect(polls).toBeGreaterThan(3)
  })

  it('does call an empty job stalled once the grace expires', async () => {
    const src = new MapsSource('http://scraper', silentLogger())
    ;(src as any).status = async () => 'working'
    ;(src as any).rawResults = async () => ''

    const out = await src.waitFor('j', 5_000, 10, 50, 100)
    expect(out.status).toBe('stalled')
  })

  it('applies the shorter stall rule once output has started', async () => {
    let n = 0
    const src = new MapsSource('http://scraper', silentLogger())
    ;(src as any).status = async () => 'working'
    // Grows once, then freezes.
    ;(src as any).rawResults = async () => (++n <= 2 ? 'row\n' : 'row\n')

    const out = await src.waitFor('j', 5_000, 10, 100, 10_000)
    expect(out.status).toBe('stalled')
    expect(out.bytes).toBeGreaterThan(0)
  })
})

function silentLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop, child: () => silentLogger() } as any
}
