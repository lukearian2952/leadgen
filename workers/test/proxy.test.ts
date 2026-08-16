import { describe, it, expect } from 'vitest'
import { hash, stickyPortFor } from '../src/proxy/pool.js'

const MIN = 10001
const MAX = 10100

describe('hash', () => {
  it('is stable for the same key', () => {
    expect(hash('example.com')).toBe(hash('example.com'))
  })

  it('differs between keys', () => {
    expect(hash('example.com')).not.toBe(hash('example.org'))
  })
})

describe('stickyPortFor', () => {
  // Decodo addresses a sticky session by PORT, not by a username suffix — the
  // suffix form fails authentication on this account. So the whole sticky
  // mechanism rests on this mapping.
  it('always lands inside the configured port range', () => {
    for (const key of ['a.com', 'b.org', 'really-long-domain-name.co.uk', '', '日本語', '1']) {
      const port = stickyPortFor(key, MIN, MAX)
      expect(port).toBeGreaterThanOrEqual(MIN)
      expect(port).toBeLessThanOrEqual(MAX)
      expect(Number.isInteger(port)).toBe(true)
    }
  })

  it('is deterministic — the same domain returns to the same exit IP', () => {
    // This is the property that keeps a multi-page crawl coherent across
    // separate jobs: page 1 and /about must come from one exit.
    expect(stickyPortFor('medspa.com', MIN, MAX)).toBe(stickyPortFor('medspa.com', MIN, MAX))
  })

  it('spreads keys across the range rather than clumping', () => {
    const ports = new Set(
      Array.from({ length: 200 }, (_, i) => stickyPortFor(`domain-${i}.com`, MIN, MAX)),
    )
    // 200 keys over 100 ports: a sane hash should touch most of the range.
    expect(ports.size).toBeGreaterThan(50)
  })

  it('handles a single-port range without dividing by zero', () => {
    expect(stickyPortFor('anything', 10001, 10001)).toBe(10001)
  })

  it('handles an inverted range defensively', () => {
    const port = stickyPortFor('anything', 10001, 9000)
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(10001)
  })
})
