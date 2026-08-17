// POST /feedback/mailbox — the closed loop, stubbed.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Three phases have failed to move Tier A off 1, and the reason is now clear:
// nothing in this pipeline ever learns whether an address actually worked.
// `domain_patterns` only learns from a Verifalia `safe`, which is a prediction,
// not an outcome. A real send is the only ground truth there is.
//
// This endpoint is where that truth comes back in. It is deliberately not
// wired to MailForge yet — the contract and its semantics are the part worth
// getting right first, because once a sender is pointed at it every bug becomes
// a silently corrupted pattern table.
//
// ── Semantics ────────────────────────────────────────────────────────────────
//
//   delivered    The mailbox exists. Promotes the domain's pattern to
//                `verified_send` — the highest-trust source, which pattern
//                discovery is not allowed to overwrite.
//   hard_bounce  The mailbox does not exist. Marks the contact invalid. If the
//                domain's stored pattern was inferred from this very address,
//                that pattern is retracted: it was wrong, and leaving it would
//                make every future lead on the domain wrong the same way.
//   soft_bounce  Temporary — full mailbox, greylisting, throttling. Recorded
//                and **nothing is retracted**, because a soft bounce says
//                something about the server's mood, not the mailbox's
//                existence. Conflating the two would let one busy afternoon
//                erase a correct pattern.
//
// ── Idempotency ──────────────────────────────────────────────────────────────
//
// Senders retry webhooks. The same (email, outcome) applied twice must not
// count as two bounces or re-promote a retracted pattern, so every call is
// keyed on `mailbox_feedback (email, outcome)` and a repeat is a no-op that
// still returns 200 — a 4xx would make the sender retry harder.

import type { Pool } from 'pg'
import { inferPattern } from './lib/patterns.js'
import { isValidEmail, emailDomain } from './lib/identity.js'

export type MailboxOutcome = 'delivered' | 'hard_bounce' | 'soft_bounce'

export const MAILBOX_OUTCOMES: MailboxOutcome[] = [
  'delivered', 'hard_bounce', 'soft_bounce',
]

export interface FeedbackRequest {
  email?: unknown
  outcome?: unknown
  source?: unknown
}

export interface FeedbackResult {
  status: number
  body: {
    ok: boolean
    /** True when this exact (email, outcome) had already been recorded. */
    duplicate?: boolean
    applied?: {
      contactsUpdated: number
      patternPromoted?: string
      patternRetracted?: string
    }
    error?: string
  }
}

interface ParsedFeedback {
  email: string
  outcome: MailboxOutcome
  source: string
}

/** Validation kept separate so the HTTP layer stays a thin shell. */
export function parseFeedback(body: FeedbackRequest): ParsedFeedback | string {
  const email = String(body.email ?? '').trim().toLowerCase()
  if (!email) return 'email is required'
  if (!isValidEmail(email)) return `email "${email.slice(0, 60)}" is not a valid address`

  const outcome = String(body.outcome ?? '').trim() as MailboxOutcome
  if (!MAILBOX_OUTCOMES.includes(outcome)) {
    return `outcome must be one of ${MAILBOX_OUTCOMES.join(', ')}`
  }

  // Free-form but recorded: which sender said so matters when two disagree.
  const source = String(body.source ?? '').trim().slice(0, 100)
  return { email, outcome, source }
}

export async function applyMailboxFeedback(
  db: Pool, body: FeedbackRequest,
): Promise<FeedbackResult> {
  const parsed = parseFeedback(body)
  if (typeof parsed === 'string') {
    return { status: 400, body: { ok: false, error: parsed } }
  }
  const { email, outcome, source } = parsed
  const domain = emailDomain(email)

  // The idempotency key. `on conflict do nothing` plus `returning` means an
  // inserted row comes back and a duplicate does not, in one round trip and
  // without a read-then-write race between two concurrent webhook retries.
  const { rows: inserted } = await db.query<{ id: string }>(
    `insert into mailbox_feedback (email, outcome, source, domain)
     values ($1,$2,$3,$4)
     on conflict (email, outcome) do nothing
     returning id`,
    [email, outcome, source, domain])

  if (!inserted.length) {
    return { status: 200, body: { ok: true, duplicate: true } }
  }

  const applied: NonNullable<FeedbackResult['body']['applied']> = { contactsUpdated: 0 }

  // ── contacts ──────────────────────────────────────────────────────────────
  const status = outcome === 'delivered' ? 'safe'
               : outcome === 'hard_bounce' ? 'invalid'
               : null

  if (status) {
    const { rowCount } = await db.query(
      `update contacts
          set status = $2, provider = 'mailbox_feedback', verified_at = now(),
              evidence = evidence || jsonb_build_object(
                'mailbox_feedback', jsonb_build_object(
                  'outcome', $3::text, 'source', $4::text, 'at', now()))
        where email = $1`,
      [email, status, outcome, source])
    applied.contactsUpdated = rowCount ?? 0
  } else {
    // Soft bounce: recorded on the contact, but the verdict is left alone.
    const { rowCount } = await db.query(
      `update contacts
          set evidence = evidence || jsonb_build_object(
                'mailbox_feedback', jsonb_build_object(
                  'outcome', $2::text, 'source', $3::text, 'at', now()))
        where email = $1`,
      [email, outcome, source])
    applied.contactsUpdated = rowCount ?? 0
  }

  // ── domain_patterns ───────────────────────────────────────────────────────
  if (outcome === 'delivered') {
    // Which shape did this address use? Answerable only against the person it
    // belongs to, so it is read off the contact we already have.
    const { rows: who } = await db.query<{ first: string; last: string }>(
      `select l.owner_first_name first, l.owner_last_name last
         from contacts c join leads l on l.id = c.lead_id
        where c.email = $1 and l.owner_first_name <> ''
        limit 1`, [email])

    const pattern = who[0] ? inferPattern(email, who[0].first, who[0].last) : null
    if (pattern) {
      await db.query(
        `insert into domain_patterns
           (domain, pattern, confidence, samples, learned_from, source, updated_at)
         values ($1,$2,0.95,1,$3,'verified_send',now())
         on conflict (domain) do update
           set pattern = excluded.pattern,
               confidence = least(0.99, greatest(domain_patterns.confidence, 0.95)),
               samples = domain_patterns.samples + 1,
               learned_from = excluded.learned_from,
               source = 'verified_send', updated_at = now()`,
        [domain, pattern, email])
      applied.patternPromoted = pattern
    }
  }

  if (outcome === 'hard_bounce') {
    // Retract only a pattern this very address taught us. A hard bounce on
    // `jane@x.com` says nothing about a `first.last` pattern learned from
    // `bob.smith@x.com` — and deleting on every bounce would make one wrong
    // guess erase a correct, well-evidenced convention.
    const { rows: retracted } = await db.query<{ pattern: string }>(
      `delete from domain_patterns
        where domain = $1 and learned_from = $2
        returning pattern`,
      [domain, email])
    if (retracted[0]) applied.patternRetracted = retracted[0].pattern
  }

  return { status: 200, body: { ok: true, duplicate: false, applied } }
}
