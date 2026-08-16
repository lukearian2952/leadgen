import { describe, it, expect } from 'vitest'
import {
  isBlockResponse, hourlyCapForMx, newIpRecord, refresh, canUse,
  recordCheck, cool, chooseIp,
  COOLDOWN_MS, HOURLY_CAP_STRICT, HOURLY_CAP_DEFAULT,
} from '../src/verify/cooldown.js'

const T0 = Date.parse('2026-08-16T10:00:00.000Z')

describe('isBlockResponse', () => {
  it('treats 4xx deferrals and 4.7.x / 5.7.1 as blocks', () => {
    expect(isBlockResponse('421 4.7.0 Try again later')).toBe(true)
    expect(isBlockResponse('450 4.7.1 Client host rejected')).toBe(true)
    expect(isBlockResponse('451 Temporary local problem')).toBe(true)
    expect(isBlockResponse('550 5.7.1 Access denied')).toBe(true)
  })

  it('matches reputation wording even without a recognised code', () => {
    for (const banner of [
      'Your IP has been blocked',
      'listed on Spamhaus SBL',
      'blacklisted by policy',
      'Too many connections from your host',
    ]) {
      expect(isBlockResponse(banner)).toBe(true)
    }
  })

  // This is the distinction the whole cooldown depends on: a 550 on RCPT means
  // the mailbox does not exist, which is a *result*, not a block. Treating it
  // as a block would cool every IP the first time it found an invalid address.
  it('does not treat a plain 550 mailbox-not-found as a block', () => {
    expect(isBlockResponse('550 5.1.1 The email account does not exist')).toBe(false)
    expect(isBlockResponse('550 No such user here')).toBe(false)
    expect(isBlockResponse('250 OK')).toBe(false)
    expect(isBlockResponse('')).toBe(false)
  })
})

describe('hourlyCapForMx', () => {
  it('applies the strict cap to Google and Microsoft', () => {
    for (const mx of [
      'aspmx.l.google.com', 'ALT1.ASPMX.L.GOOGLE.COM',
      'mail.protection.outlook.com', 'example-com.mail.protection.outlook.com',
    ]) {
      expect(hourlyCapForMx(mx)).toBe(HOURLY_CAP_STRICT)
    }
  })

  it('applies the default cap elsewhere', () => {
    expect(hourlyCapForMx('mx.zoho.com')).toBe(HOURLY_CAP_DEFAULT)
    expect(hourlyCapForMx('mail.privateemail.com')).toBe(HOURLY_CAP_DEFAULT)
  })

  it('ignores a trailing dot from DNS', () => {
    expect(hourlyCapForMx('aspmx.l.google.com.')).toBe(HOURLY_CAP_STRICT)
  })

  // Guards against a naive `includes('google.com')` implementation, which would
  // let an attacker-registered lookalike inherit the wrong cap.
  it('does not match a lookalike domain by substring', () => {
    expect(hourlyCapForMx('mx.google.com.evil.example')).toBe(HOURLY_CAP_DEFAULT)
    expect(hourlyCapForMx('notgoogle.com')).toBe(HOURLY_CAP_DEFAULT)
  })
})

describe('hourly caps', () => {
  it('blocks further use once the strict cap is reached, per MX', () => {
    let record = newIpRecord('10.0.0.1', T0)
    for (let i = 0; i < HOURLY_CAP_STRICT; i++) record = recordCheck(record, T0)

    expect(canUse(record, 'aspmx.l.google.com', T0)).toBe(false)
    // The same IP still has headroom toward a non-strict MX.
    expect(canUse(record, 'mx.zoho.com', T0)).toBe(true)
  })

  it('resets the counter when the hour rolls over', () => {
    let record = newIpRecord('10.0.0.1', T0)
    for (let i = 0; i < HOURLY_CAP_STRICT; i++) record = recordCheck(record, T0)
    expect(canUse(record, 'aspmx.l.google.com', T0)).toBe(false)

    const nextHour = T0 + 3_600_000
    expect(canUse(record, 'aspmx.l.google.com', nextHour)).toBe(true)
    expect(refresh(record, nextHour).checksThisHour).toBe(0)
  })
})

describe('cooldown', () => {
  it('cools an IP for a full 24 hours and releases it after', () => {
    const record = cool(newIpRecord('10.0.0.1', T0), '421 4.7.0 blocked', T0)

    expect(record.state).toBe('cooling')
    expect(record.coolingUntil).toBe(T0 + COOLDOWN_MS)
    expect(record.blocksSeen).toBe(1)
    expect(canUse(record, 'mx.zoho.com', T0)).toBe(false)

    // Still cooling one minute before expiry.
    expect(canUse(record, 'mx.zoho.com', T0 + COOLDOWN_MS - 60_000)).toBe(false)

    const revived = refresh(record, T0 + COOLDOWN_MS)
    expect(revived.state).toBe('active')
    expect(revived.coolingUntil).toBeNull()
    expect(canUse(revived, 'mx.zoho.com', T0 + COOLDOWN_MS)).toBe(true)
  })

  it('keeps the block count across cooldown cycles', () => {
    let record = cool(newIpRecord('10.0.0.1', T0), '421', T0)
    record = refresh(record, T0 + COOLDOWN_MS)
    record = cool(record, '450', T0 + COOLDOWN_MS)
    expect(record.blocksSeen).toBe(2)
  })
})

describe('chooseIp — rotation and reroute', () => {
  const ips = () => [
    newIpRecord('10.0.0.1', T0),
    newIpRecord('10.0.0.2', T0),
    newIpRecord('10.0.0.3', T0),
  ]

  it('round-robins across healthy IPs', () => {
    const records = ips()
    const picks = [0, 1, 2, 3].map(c => chooseIp(records, 'mx.zoho.com', T0, c).ip)
    expect(picks).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1'])
  })

  // The behaviour the brief calls for explicitly: a forced 421 cools that IP
  // and traffic reroutes to the others rather than stopping.
  it('reroutes away from an IP that just took a 421', () => {
    const records = ips()
    const banner = '421 4.7.0 Too many connections, try again later'
    expect(isBlockResponse(banner)).toBe(true)

    records[0] = cool(records[0], banner, T0)

    const chosen = new Set(
      [0, 1, 2, 3, 4, 5].map(c => chooseIp(records, 'aspmx.l.google.com', T0, c).ip),
    )
    expect(chosen.has('10.0.0.1')).toBe(false)
    expect(chosen).toEqual(new Set(['10.0.0.2', '10.0.0.3']))
  })

  it('reports allCooling distinctly from allAtCap', () => {
    const cooling = ips().map(r => cool(r, '421 blocked', T0))
    const d1 = chooseIp(cooling, 'mx.zoho.com', T0, 0)
    expect(d1).toEqual({ ip: null, allCooling: true, allAtCap: false })

    // Healthy but exhausted for this hour is a different situation: waiting
    // fixes it, so we must not burn Verifalia budget on it.
    const capped = ips().map(r => {
      let next = r
      for (let i = 0; i < HOURLY_CAP_STRICT; i++) next = recordCheck(next, T0)
      return next
    })
    const d2 = chooseIp(capped, 'aspmx.l.google.com', T0, 0)
    expect(d2).toEqual({ ip: null, allCooling: false, allAtCap: true })
  })

  it('returns no IP when none are configured', () => {
    expect(chooseIp([], 'mx.zoho.com', T0, 0))
      .toEqual({ ip: null, allCooling: false, allAtCap: false })
  })

  it('recovers automatically once cooldowns expire', () => {
    const records = ips().map(r => cool(r, '421 blocked', T0))
    expect(chooseIp(records, 'mx.zoho.com', T0, 0).allCooling).toBe(true)

    const later = T0 + COOLDOWN_MS + 1000
    const decision = chooseIp(records, 'mx.zoho.com', later, 0)
    expect(decision.allCooling).toBe(false)
    expect(decision.ip).toBe('10.0.0.1')
  })
})
