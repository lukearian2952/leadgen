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
