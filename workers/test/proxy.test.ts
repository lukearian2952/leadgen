import { describe, it, expect } from 'vitest'
import { sessionId } from '../src/proxy/pool.js'

describe('sessionId', () => {
  it('is stable for the same key', () => {
    expect(sessionId('example.com')).toBe(sessionId('example.com'))
  })

  it('differs between keys', () => {
    expect(sessionId('example.com')).not.toBe(sessionId('example.org'))
  })

  // Decodo encodes the session in the proxy username, so the id has to survive
  // being pasted into `user-session-<id>-sessionduration-10` unescaped.
  it('is short and alphanumeric so it is safe in a proxy username', () => {
    for (const key of ['example.com', 'a@b.com', 'https://x.y/z?q=1', '日本語', '']) {
      const id = sessionId(key)
      expect(id).toMatch(/^[a-z0-9]+$/)
      expect(id.length).toBeLessThanOrEqual(7)
    }
  })
})
