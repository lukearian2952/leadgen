import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError, declaredVars } from '../src/config.js'

const CORE = {
  DATABASE_URL: 'postgres://pooled/db',
  DATABASE_URL_DIRECT: 'postgres://direct/db',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
}

describe('fail-fast config', () => {
  it('names every missing required variable at once, not just the first', () => {
    let error: ConfigError | undefined
    try {
      loadConfig({ WORKER_ROLE: 'verify', DATABASE_URL: 'postgres://pooled/db' } as NodeJS.ProcessEnv)
    } catch (err) {
      error = err as ConfigError
    }

    expect(error).toBeInstanceOf(ConfigError)
    // A worker that starts and then dies on the third lead is far worse than
    // one that refuses to boot with the full list.
    for (const name of [
      'DATABASE_URL_DIRECT', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
      'VERIFY_URL', 'VERIFY_IPS', 'VERIFY_HELO_DOMAIN', 'VERIFY_FROM_EMAIL',
    ]) {
      expect(error!.message).toContain(name)
    }
    expect(error!.message).not.toContain('DATABASE_URL_DIRECT:')
  })

  it('only requires what the role actually needs', () => {
    // A verify worker does not need Decodo or SearXNG.
    const config = loadConfig({
      ...CORE,
      WORKER_ROLE: 'verify',
      VERIFY_URL: 'http://verify-svc:8080',
      VERIFY_IPS: '92.112.184.200',
      VERIFY_HELO_DOMAIN: 'verify1.bezbuilder.com',
      VERIFY_FROM_EMAIL: 'verify@bezbuilder.com',
    } as NodeJS.ProcessEnv)

    expect(config.role).toBe('verify')
    expect(config.verify.ips).toEqual(['92.112.184.200'])
    expect(config.verifier).toBe('hybrid')
  })

  it('requires the union of everything when the role is "all"', () => {
    expect(() => loadConfig({ ...CORE, WORKER_ROLE: 'all' } as NodeJS.ProcessEnv))
      .toThrowError(/DECODO_USERNAME/)
  })

  it('rejects an unknown WORKER_ROLE rather than defaulting', () => {
    expect(() => loadConfig({ ...CORE, WORKER_ROLE: 'crawler' } as NodeJS.ProcessEnv))
      .toThrowError(/WORKER_ROLE="crawler" is not valid/)
  })

  it('rejects an unknown VERIFIER value', () => {
    expect(() => loadConfig({
      ...CORE, WORKER_ROLE: 'scheduler', VERIFIER: 'truemail',
    } as NodeJS.ProcessEnv)).toThrowError(/VERIFIER="truemail"/)
  })

  it('refuses VERIFIER=verifalia without Verifalia credentials', () => {
    expect(() => loadConfig({
      ...CORE, WORKER_ROLE: 'scheduler', VERIFIER: 'verifalia',
    } as NodeJS.ProcessEnv)).toThrowError(/VERIFALIA_USERNAME/)
  })

  it('parses multiple VERIFY_IPS and trims whitespace', () => {
    const config = loadConfig({
      ...CORE, WORKER_ROLE: 'verify',
      VERIFY_URL: 'http://verify-svc:8080',
      VERIFY_IPS: ' 1.2.3.4 , 5.6.7.8 ',
      VERIFY_HELO_DOMAIN: 'verify1.bezbuilder.com',
      VERIFY_FROM_EMAIL: 'verify@bezbuilder.com',
    } as NodeJS.ProcessEnv)
    expect(config.verify.ips).toEqual(['1.2.3.4', '5.6.7.8'])
  })
})

describe('LINKEDIN_ACCOUNTS parsing', () => {
  const env = (accounts: string) => ({
    ...CORE, WORKER_ROLE: 'scheduler', LINKEDIN_ACCOUNTS: accounts,
  }) as NodeJS.ProcessEnv

  it('parses email:password:li_at triples', () => {
    const config = loadConfig(env('a@x.com:pw1:AQED123,b@y.com:pw2:AQED456'))
    expect(config.linkedinAccounts).toEqual([
      { email: 'a@x.com', password: 'pw1', liAt: 'AQED123' },
      { email: 'b@y.com', password: 'pw2', liAt: 'AQED456' },
    ])
  })

  // li_at cookies contain colons and base64 padding; a naive split(':') would
  // silently truncate the cookie and every LinkedIn request would 401.
  it('keeps colons inside the li_at cookie', () => {
    const config = loadConfig(env('a@x.com:pw:AQEDAT:xyz:=='))
    expect(config.linkedinAccounts[0].liAt).toBe('AQEDAT:xyz:==')
  })

  it('rejects a malformed entry instead of importing half an account', () => {
    expect(() => loadConfig(env('a@x.com:onlypassword')))
      .toThrowError(/LINKEDIN_ACCOUNTS entry/)
  })

  it('treats an empty value as no accounts', () => {
    expect(loadConfig(env('')).linkedinAccounts).toEqual([])
  })
})

describe('declaredVars', () => {
  it('is the single source of truth shared with .env.example', () => {
    const names = declaredVars().map(v => v.name)
    expect(new Set(names).size).toBe(names.length)
    for (const required of [
      'DATABASE_URL', 'DATABASE_URL_DIRECT', 'VERIFY_URL', 'VERIFY_IPS',
      'VERIFY_HELO_DOMAIN', 'VERIFY_FROM_EMAIL', 'VERIFIER',
      'DECODO_USERNAME', 'SEARXNG_URL', 'CRAWL4AI_URL', 'GOOGLE_MAPS_SCRAPER_URL',
      'WORKER_CONCURRENCY', 'LOG_LEVEL', 'METRICS_PORT',
    ]) {
      expect(names).toContain(required)
    }
    // Reacher is gone; nothing may still read a REACHER_* variable.
    expect(names.filter(n => n.startsWith('REACHER_'))).toEqual([])
  })
})
