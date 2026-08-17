import { describe, it, expect, beforeEach } from 'vitest'
import { parseFeedback, applyMailboxFeedback, MAILBOX_OUTCOMES } from '../src/feedback.js'
import type { Pool } from 'pg'

// A fake pool that records every statement and replays scripted results. The
// point of these tests is the *semantics* — what gets promoted, what gets
// retracted, what a duplicate does — so the SQL is asserted by shape rather
// than executed.
interface Call { sql: string; params: unknown[] }

function fakeDb(script: Array<{ rows?: unknown[]; rowCount?: number }>): Pool & { calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const db = {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      const next = script[i++] ?? {}
      return { rows: next.rows ?? [], rowCount: next.rowCount ?? (next.rows?.length ?? 0) }
    },
  }
  return db as unknown as Pool & { calls: Call[] }
}

const find = (db: { calls: Call[] }, needle: string) =>
  db.calls.filter(c => c.sql.includes(needle))

describe('parseFeedback', () => {
  it('accepts the three documented outcomes', () => {
    for (const outcome of MAILBOX_OUTCOMES) {
      expect(parseFeedback({ email: 'a@b.com', outcome, source: 'mailforge' }))
        .toMatchObject({ email: 'a@b.com', outcome })
    }
  })

  it('lowercases and trims the address', () => {
    expect(parseFeedback({ email: '  Jane@Example.COM ', outcome: 'delivered' }))
      .toMatchObject({ email: 'jane@example.com' })
  })

  it('rejects a missing or malformed address', () => {
    expect(parseFeedback({ outcome: 'delivered' })).toBe('email is required')
    expect(String(parseFeedback({ email: 'not-an-email', outcome: 'delivered' })))
      .toContain('not a valid address')
  })

  it('rejects an unknown outcome — including a plausible one', () => {
    expect(String(parseFeedback({ email: 'a@b.com', outcome: 'bounced' })))
      .toContain('outcome must be one of')
    expect(String(parseFeedback({ email: 'a@b.com', outcome: '' })))
      .toContain('outcome must be one of')
  })

  it('tolerates a missing source', () => {
    expect(parseFeedback({ email: 'a@b.com', outcome: 'delivered' }))
      .toMatchObject({ source: '' })
  })
})

describe('applyMailboxFeedback — validation', () => {
  it('returns 400 without touching the database', async () => {
    const db = fakeDb([])
    const out = await applyMailboxFeedback(db, { email: 'nope', outcome: 'delivered' })
    expect(out.status).toBe(400)
    expect(out.body.ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
})

describe('applyMailboxFeedback — idempotency', () => {
  it('is a no-op the second time and still returns 200', async () => {
    // Insert returns no row => the (email, outcome) pair already existed.
    const db = fakeDb([{ rows: [] }])
    const out = await applyMailboxFeedback(db, {
      email: 'jane@x.com', outcome: 'hard_bounce', source: 'mailforge',
    })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, duplicate: true })
    // Nothing after the insert ran — no double-counted bounce.
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain('on conflict (email, outcome) do nothing')
  })

  it('a 200 on duplicate is deliberate — a 4xx would make senders retry harder', async () => {
    const db = fakeDb([{ rows: [] }])
    const out = await applyMailboxFeedback(db, { email: 'a@b.com', outcome: 'delivered' })
    expect(out.status).toBe(200)
  })
})

describe('applyMailboxFeedback — delivered', () => {
  it('marks contacts safe and promotes the pattern to verified_send', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },                                  // insert feedback
      { rowCount: 2 },                                            // update contacts
      { rows: [{ first: 'Jane', last: 'Smith' }] },               // who owns it
      { rowCount: 1 },                                            // upsert pattern
    ])
    const out = await applyMailboxFeedback(db, {
      email: 'jane.smith@x.com', outcome: 'delivered', source: 'mailforge',
    })

    expect(out.status).toBe(200)
    expect(out.body.applied).toMatchObject({
      contactsUpdated: 2, patternPromoted: 'first.last',
    })
    const upsert = find(db, 'insert into domain_patterns')[0]
    expect(upsert.sql).toContain("'verified_send'")
    expect(upsert.params).toContain('x.com')
    expect(upsert.params).toContain('first.last')
  })

  it('records the delivery but promotes nothing when the shape matches no pattern', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },
      { rowCount: 1 },
      { rows: [{ first: 'Jane', last: 'Smith' }] },
    ])
    const out = await applyMailboxFeedback(db, { email: 'drjane@x.com', outcome: 'delivered' })
    expect(out.body.applied?.patternPromoted).toBeUndefined()
    expect(find(db, 'insert into domain_patterns')).toHaveLength(0)
  })

  it('promotes nothing when no named owner is on file', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },
      { rowCount: 1 },
      { rows: [] },                       // no lead with a name
    ])
    const out = await applyMailboxFeedback(db, { email: 'jane.smith@x.com', outcome: 'delivered' })
    expect(out.body.applied?.patternPromoted).toBeUndefined()
  })
})

describe('applyMailboxFeedback — hard_bounce', () => {
  it('marks the contact invalid and retracts a pattern this address taught', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },
      { rowCount: 1 },                            // contacts -> invalid
      { rows: [{ pattern: 'first.last' }] },      // delete returning
    ])
    const out = await applyMailboxFeedback(db, {
      email: 'jane.smith@x.com', outcome: 'hard_bounce', source: 'mailforge',
    })
    expect(out.body.applied).toMatchObject({ patternRetracted: 'first.last' })

    const upd = find(db, 'update contacts')[0]
    expect(upd.params).toContain('invalid')

    // Retraction is scoped to the address that taught it, not the whole domain.
    const del = find(db, 'delete from domain_patterns')[0]
    expect(del.sql).toContain('learned_from = $2')
    expect(del.params).toEqual(['x.com', 'jane.smith@x.com'])
  })

  it('retracts nothing when the domain pattern came from a different address', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },
      { rowCount: 1 },
      { rows: [] },                    // delete matched nothing
    ])
    const out = await applyMailboxFeedback(db, { email: 'jane@x.com', outcome: 'hard_bounce' })
    expect(out.body.applied?.patternRetracted).toBeUndefined()
  })
})

describe('applyMailboxFeedback — soft_bounce', () => {
  it('records the event but changes no verdict and retracts nothing', async () => {
    const db = fakeDb([
      { rows: [{ id: 'fb1' }] },
      { rowCount: 1 },
    ])
    const out = await applyMailboxFeedback(db, {
      email: 'jane.smith@x.com', outcome: 'soft_bounce', source: 'mailforge',
    })

    expect(out.status).toBe(200)
    expect(out.body.applied?.contactsUpdated).toBe(1)

    // A full mailbox says nothing about whether the mailbox exists.
    const upd = find(db, 'update contacts')[0]
    expect(upd.sql).not.toContain('set status')
    expect(find(db, 'delete from domain_patterns')).toHaveLength(0)
    expect(find(db, 'insert into domain_patterns')).toHaveLength(0)
  })
})
