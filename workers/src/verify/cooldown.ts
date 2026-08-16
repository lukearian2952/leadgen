// Outbound-IP health for SMTP verification.
//
// An IP that gets a 4xx block from Gmail or Outlook is not having a bad
// millisecond — it is being told to go away for hours. Retrying through it
// deepens the block and, repeated enough, gets the IP onto a public list, at
// which point it is useless for verification *and* for anything else we ever
// send from it. So a block takes the IP out for a full 24 hours.
//
// The state lives in Postgres (`verifier_ip_state`), not in verify-svc memory:
// a container restart must not un-cool an IP, and with more than one verify
// worker the decision has to be shared. This module is the pure state machine
// over that table; it is deliberately free of I/O so it can be unit-tested,
// which the brief requires.

export const COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Hourly per-IP ceilings, per the brief. Gmail and Microsoft are stricter. */
export const HOURLY_CAP_STRICT = 150
export const HOURLY_CAP_DEFAULT = 400

/**
 * SMTP responses that mean "this IP is being refused", as opposed to "this
 * mailbox does not exist".
 *
 * The distinction is the whole point. A 550 on RCPT is a *result* — the address
 * is invalid, record it and move on. A 421/450/451, or any 4.7.x / 5.7.1, is
 * about us: greylisting, rate limiting, reputation, or an outright block. Only
 * the second kind cools the IP. Conflating them would cool every IP the moment
 * it found an invalid address.
 */
const BLOCK_CODE_RE = /\b(421|450|451)\b|\b4\.7\.\d+\b|\b5\.7\.1\b/
const BLOCK_TEXT_RE = /\b(blocked|blacklist(ed)?|spamhaus|barracuda|banned|denied due to|reputation|too many connections|rate limited)\b/i

export function isBlockResponse(response: string): boolean {
  const text = response ?? ''
  return BLOCK_CODE_RE.test(text) || BLOCK_TEXT_RE.test(text)
}

/** Mailbox providers we throttle to the strict hourly cap. */
const STRICT_MX_RE = /(^|\.)(google\.com|googlemail\.com|gmail\.com|aspmx\.l\.google\.com|outlook\.com|hotmail\.com|protection\.outlook\.com|microsoft\.com|office365\.com)$/i

export function hourlyCapForMx(mxHost: string): number {
  const host = (mxHost ?? '').toLowerCase().replace(/\.$/, '')
  return STRICT_MX_RE.test(host) ? HOURLY_CAP_STRICT : HOURLY_CAP_DEFAULT
}

export type IpState = 'active' | 'cooling' | 'disabled'

export interface IpRecord {
  ip: string
  state: IpState
  coolingUntil: number | null
  checksThisHour: number
  hourWindowStart: number
  blocksSeen: number
  lastReason: string
}

export function newIpRecord(ip: string, now: number): IpRecord {
  return {
    ip,
    state: 'active',
    coolingUntil: null,
    checksThisHour: 0,
    hourWindowStart: startOfHour(now),
    blocksSeen: 0,
    lastReason: '',
  }
}

function startOfHour(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000
}

/**
 * Roll the hourly counter over if we've crossed into a new hour, and expire a
 * cooldown that has run its course. Pure: returns a new record.
 */
export function refresh(record: IpRecord, now: number): IpRecord {
  let next = record

  const currentHour = startOfHour(now)
  if (currentHour > next.hourWindowStart) {
    next = { ...next, hourWindowStart: currentHour, checksThisHour: 0 }
  }

  if (next.state === 'cooling' && next.coolingUntil !== null && now >= next.coolingUntil) {
    next = { ...next, state: 'active', coolingUntil: null, lastReason: '' }
  }

  return next
}

/** Can this IP take another check toward this MX right now? */
export function canUse(record: IpRecord, mxHost: string, now: number): boolean {
  const current = refresh(record, now)
  if (current.state !== 'active') return false
  return current.checksThisHour < hourlyCapForMx(mxHost)
}

export function recordCheck(record: IpRecord, now: number): IpRecord {
  const current = refresh(record, now)
  return { ...current, checksThisHour: current.checksThisHour + 1 }
}

/** Put an IP in the sin bin for 24 hours. */
export function cool(record: IpRecord, reason: string, now: number): IpRecord {
  const current = refresh(record, now)
  return {
    ...current,
    state: 'cooling',
    coolingUntil: now + COOLDOWN_MS,
    blocksSeen: current.blocksSeen + 1,
    lastReason: reason.slice(0, 500),
  }
}

export interface RoutingDecision {
  /** IP to dial from, or null when none is usable. */
  ip: string | null
  /** True when every configured IP is cooling — route to Verifalia instead. */
  allCooling: boolean
  /** True when IPs exist and are active but all are at their hourly cap. */
  allAtCap: boolean
}

/**
 * Pick the next IP, round-robin over the usable ones.
 *
 * `cursor` is the caller's rotation counter; passing it in keeps this pure and
 * lets the caller persist rotation across calls.
 */
export function chooseIp(
  records: IpRecord[], mxHost: string, now: number, cursor: number,
): RoutingDecision {
  if (!records.length) return { ip: null, allCooling: false, allAtCap: false }

  const refreshed = records.map(r => refresh(r, now))
  const notCooling = refreshed.filter(r => r.state === 'active')

  if (!notCooling.length) {
    return { ip: null, allCooling: true, allAtCap: false }
  }

  const usable = notCooling.filter(r => r.checksThisHour < hourlyCapForMx(mxHost))
  if (!usable.length) {
    return { ip: null, allCooling: false, allAtCap: true }
  }

  // Round-robin from the caller's cursor so load spreads evenly rather than
  // always hammering the first healthy IP.
  const index = ((cursor % usable.length) + usable.length) % usable.length
  return { ip: usable[index].ip, allCooling: false, allAtCap: false }
}
