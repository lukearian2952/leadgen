// Environment configuration, validated once at boot.
//
// The rule from the brief: "Fail fast at worker start with a clear message
// listing any missing required variable; never fall back silently."
//
// v1 did the opposite — `Deno.env.get('APIFY_API_KEY')!` asserted non-null and
// then failed somewhere deep in a request, and the two owner-lookup provider
// keys were simply never set, so that stage logged a warning and skipped for
// months without anyone noticing. Anything genuinely optional here has to say
// what degrades when it is absent, and that degradation is logged loudly at
// boot rather than per-lead.

export type WorkerRole =
  | 'all' | 'maps' | 'serp' | 'crawl' | 'linkedin'
  | 'registry' | 'enrich' | 'verify' | 'scheduler'

export const WORKER_ROLES: WorkerRole[] = [
  'all', 'maps', 'serp', 'crawl', 'linkedin',
  'registry', 'enrich', 'verify', 'scheduler',
]

interface VarSpec {
  name: string
  /** Roles that cannot start without it. 'all' means every role. */
  requiredFor: WorkerRole[]
  /** What stops working when it is missing, for the boot warning. */
  degrades?: string
}

/**
 * Declared centrally so `.env.example`, the docs table and the boot check can
 * never drift apart. A variable that is not in this list is not read anywhere.
 */
const SPECS: VarSpec[] = [
  // Core
  { name: 'DATABASE_URL',             requiredFor: ['all'] },
  { name: 'DATABASE_URL_DIRECT',      requiredFor: ['all'] },
  { name: 'SUPABASE_URL',             requiredFor: ['all'] },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', requiredFor: ['all'] },

  // LLM
  { name: 'ANTHROPIC_API_KEY', requiredFor: ['crawl', 'enrich'],
    degrades: 'site-crawl owner extraction and name inference are skipped' },

  // Proxies
  { name: 'DECODO_USERNAME', requiredFor: ['maps', 'serp', 'crawl', 'linkedin'],
    degrades: 'all outbound scraping falls back to datacenter IPs and will be blocked quickly' },
  { name: 'DECODO_PASSWORD', requiredFor: ['maps', 'serp', 'crawl', 'linkedin'] },
  { name: 'DECODO_HOST',     requiredFor: ['maps', 'serp', 'crawl', 'linkedin'] },
  { name: 'DECODO_PORT',     requiredFor: ['maps', 'serp', 'crawl', 'linkedin'] },
  { name: 'DECODO_COUNTRY', requiredFor: [],
    degrades: "exits are global rather than US-targeted — Google will serve a different, localised result set" },
  { name: 'DECODO_STICKY_PORT_MIN', requiredFor: [], degrades: 'defaults to 10001' },
  { name: 'DECODO_STICKY_PORT_MAX', requiredFor: [], degrades: 'defaults to 10100' },
  { name: 'DECODO_STICKY_TTL', requiredFor: [],
    degrades: 'sticky sessions default to 600s' },

  // Services
  { name: 'SEARXNG_URL',              requiredFor: ['serp'] },
  { name: 'SERPER_API_KEY',           requiredFor: [],
    degrades: 'SERP runs on self-hosted SearXNG, paced to ~3.6 queries/min — the ' +
              'rate Google CSE tolerates, and the only upstream honouring site:' },
  { name: 'SERP_PROVIDER',            requiredFor: [],
    degrades: 'provider chosen by whether SERPER_API_KEY is set' },
  { name: 'SEARXNG_MIN_QUERY_INTERVAL_MS', requiredFor: [],
    degrades: 'SearXNG pacing defaults to 16700ms between queries' },
  { name: 'SERPER_MAX_QUERIES_PER_CAMPAIGN', requiredFor: [],
    degrades: 'Serper query cap defaults to 500 per campaign' },
  { name: 'CRAWL4AI_URL',             requiredFor: ['crawl'] },
  { name: 'GOOGLE_MAPS_SCRAPER_URL',  requiredFor: ['maps'] },
  { name: 'GOOGLE_PLACES_API_KEY',    requiredFor: [],
    degrades: 'place_id resolution fallback is unavailable (scraper-only Maps discovery)' },

  // Registry
  // Deliberately no `degrades` note. Running Socrata anonymously is an accepted
  // standing decision, not a degradation to be reported at every boot: the
  // shared pool completes every ingest we run, NY whole-state included, and a
  // warning nobody intends to act on trains people to ignore the boot log.
  { name: 'SOCRATA_APP_TOKEN', requiredFor: [] },
  { name: 'REGISTRY_REVERSE_STATEWIDE', requiredFor: [],
    degrades: 'reverse officer lookup stays county-scoped (no statewide fallback)' },
  { name: 'REGISTRY_MAX_DB_MB', requiredFor: [],
    degrades: 'registry ingest runs without a database-size ceiling' },
  { name: 'REGISTRY_DATABASE_URL', requiredFor: ['registry'],
    degrades: 'registry lookups have no database to read' },

  // Mailbox construction
  { name: 'PATTERN_LADDER_EXTRAS', requiredFor: [],
    degrades: 'candidate ladder is the standard six shapes (measured best on med spa)' },

  // Verification
  { name: 'VERIFY_URL',           requiredFor: ['verify'] },
  { name: 'VERIFY_IPS',           requiredFor: ['verify'] },
  { name: 'VERIFY_HELO_DOMAIN',   requiredFor: ['verify'] },
  { name: 'VERIFY_FROM_EMAIL',    requiredFor: ['verify'] },
  { name: 'VERIFIER',             requiredFor: [],
    degrades: "defaults to 'hybrid'" },
  { name: 'VERIFALIA_USERNAME',   requiredFor: [],
    degrades: 'no safety net when verify-svc returns unknown/risky on a Tier-B candidate' },
  { name: 'VERIFALIA_PASSWORD',   requiredFor: [] },
  { name: 'VERIFALIA_MAX_CENTS_PER_CAMPAIGN', requiredFor: [],
    degrades: 'defaults to 500' },

  // LinkedIn
  { name: 'LINKEDIN_ACCOUNTS', requiredFor: [],
    degrades: 'LinkedIn discovery is SERP-only (no profile enrichment)' },

  // Runtime
  { name: 'WORKER_CONCURRENCY', requiredFor: [], degrades: 'defaults to 5' },
  { name: 'LOG_LEVEL',          requiredFor: [], degrades: "defaults to 'info'" },
  { name: 'METRICS_PORT',       requiredFor: [], degrades: 'defaults to 9100' },
]

export class ConfigError extends Error {}

function readRole(env: NodeJS.ProcessEnv): WorkerRole {
  // Reads the injected env, not process.env. Taking it from the ambient
  // process made loadConfig(env) a half-lie: callers could override every
  // variable except the one that decides which variables are required.
  const raw = (env.WORKER_ROLE ?? 'all').trim() as WorkerRole
  if (!WORKER_ROLES.includes(raw)) {
    throw new ConfigError(
      `WORKER_ROLE="${raw}" is not valid. Expected one of: ${WORKER_ROLES.join(', ')}`,
    )
  }
  return raw
}

function isRequired(spec: VarSpec, role: WorkerRole): boolean {
  if (spec.requiredFor.includes('all')) return true
  // A combined worker needs everything every role needs.
  if (role === 'all') return spec.requiredFor.length > 0
  return spec.requiredFor.includes(role)
}

export interface Config {
  role: WorkerRole
  databaseUrl: string
  databaseUrlDirect: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  anthropicApiKey: string
  decodo: {
    username: string
    password: string
    host: string
    /** Rotating endpoint. Decodo uses 7000; a new IP on every request. */
    rotatingPort: number
    /** Sticky sessions are addressed by PORT, not by a username suffix. */
    stickyPortMin: number
    stickyPortMax: number
    /** ISO country for exit targeting, e.g. 'us'. Empty disables targeting. */
    country: string
    stickyTtlSeconds: number
  }
  searxngUrl: string
  /** '' = choose by whether serperApiKey is set; 'searxng' | 'serper' forces one. */
  serpProvider: string
  serperApiKey: string
  /** Process-wide spacing between SearXNG queries. See sources/serp-provider.ts. */
  searxngMinQueryIntervalMs: number
  /** Hard per-campaign ceiling on paid SERP queries. */
  serperMaxQueriesPerCampaign: number
  crawl4aiUrl: string
  mapsScraperUrl: string
  googlePlacesApiKey: string
  socrataAppToken: string
  /** Fall back to a statewide officer search when the county scope misses. */
  registryReverseStatewide: boolean
  /**
   * Connection string for **registry-db**, the local Postgres holding
   * `registry_entities` and `zip_county`.
   *
   * Separate from `DATABASE_URL` on purpose. Supabase is on the free plan
   * (500 MB, read-only past it) and the registry is the one table that grows
   * without bound; it is also entirely internal — no RLS policy references it,
   * no Realtime subscription watches it, the frontend has never read it. So it
   * sits next to the workers instead, and lead data stays in Supabase.
   */
  registryDatabaseUrl: string
  /**
   * Abort a registry ingest once registry-db's own size reaches this many MB.
   *
   * The host has 122 GB free and also runs Odoo, n8n and three other Postgres
   * instances, so this is about being a good neighbour rather than a plan
   * limit. 0 disables the ceiling.
   */
  registryMaxDbMb: number
  /** Append the four Phase 4 extra shapes to the candidate ladder. */
  patternLadderExtras: boolean
  verify: {
    url: string
    ips: string[]
    heloDomain: string
    fromEmail: string
  }
  verifier: 'reacher' | 'verifalia' | 'hybrid'
  verifalia: {
    username: string
    password: string
    maxCentsPerCampaign: number
  }
  linkedinAccounts: Array<{ email: string; password: string; liAt: string }>
  concurrency: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  metricsPort: number
}

/** Parse `LINKEDIN_ACCOUNTS=email:pass:li_at,email:pass:li_at`. */
function parseLinkedinAccounts(raw: string) {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    // The li_at cookie can itself contain ':' — split off only the first two.
    const first = entry.indexOf(':')
    const second = entry.indexOf(':', first + 1)
    if (first < 0 || second < 0) {
      throw new ConfigError(
        `LINKEDIN_ACCOUNTS entry "${entry.slice(0, 20)}…" is malformed. ` +
        'Expected email:password:li_at, comma separated.',
      )
    }
    return {
      email: entry.slice(0, first),
      password: entry.slice(first + 1, second),
      liAt: entry.slice(second + 1),
    }
  })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = readRole(env)

  const missing: string[] = []
  const degraded: string[] = []

  for (const spec of SPECS) {
    const value = (env[spec.name] ?? '').trim()
    if (value) continue
    if (isRequired(spec, role)) missing.push(spec.name)
    else if (spec.degrades) degraded.push(`${spec.name} — ${spec.degrades}`)
  }

  if (missing.length) {
    throw new ConfigError(
      `Cannot start WORKER_ROLE=${role}: ${missing.length} required ` +
      `environment variable${missing.length === 1 ? '' : 's'} missing.\n` +
      missing.map(n => `  - ${n}`).join('\n') +
      '\nSee .env.example for where each value comes from.',
    )
  }

  // Not thrown — printed by the caller so it lands in the structured log.
  ;(loadConfig as { lastDegraded?: string[] }).lastDegraded = degraded

  const verifier = (env.VERIFIER ?? 'hybrid').trim() as Config['verifier']
  if (!['reacher', 'verifalia', 'hybrid'].includes(verifier)) {
    throw new ConfigError(
      `VERIFIER="${verifier}" is not valid. Expected reacher, verifalia or hybrid. ` +
      "('reacher' is kept as an alias for the self-hosted verifier — it now routes " +
      'to verify-svc, which wraps AfterShip/email-verifier.)',
    )
  }
  if (verifier === 'verifalia' && !(env.VERIFALIA_USERNAME ?? '').trim()) {
    throw new ConfigError('VERIFIER=verifalia but VERIFALIA_USERNAME is not set.')
  }

  const ips = (env.VERIFY_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean)

  return {
    role,
    databaseUrl:       env.DATABASE_URL!,
    databaseUrlDirect: env.DATABASE_URL_DIRECT!,
    supabaseUrl:       env.SUPABASE_URL!,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    anthropicApiKey:   env.ANTHROPIC_API_KEY ?? '',
    decodo: {
      username: env.DECODO_USERNAME ?? '',
      password: env.DECODO_PASSWORD ?? '',
      host:     env.DECODO_HOST ?? '',
      rotatingPort:  Number(env.DECODO_PORT ?? 7000),
      stickyPortMin: Number(env.DECODO_STICKY_PORT_MIN ?? 10001),
      stickyPortMax: Number(env.DECODO_STICKY_PORT_MAX ?? 10100),
      country: (env.DECODO_COUNTRY ?? 'us').trim().toLowerCase(),
      stickyTtlSeconds: Number(env.DECODO_STICKY_TTL ?? 600),
    },
    searxngUrl:         env.SEARXNG_URL ?? '',
    serpProvider:       env.SERP_PROVIDER ?? '',
    serperApiKey:       env.SERPER_API_KEY ?? '',
    // 16.7s ≈ the nine-queries-per-two-minutes Google CSE actually tolerated.
    searxngMinQueryIntervalMs:
      Number(env.SEARXNG_MIN_QUERY_INTERVAL_MS ?? 16_700),
    serperMaxQueriesPerCampaign:
      Number(env.SERPER_MAX_QUERIES_PER_CAMPAIGN ?? 500),
    crawl4aiUrl:        env.CRAWL4AI_URL ?? '',
    mapsScraperUrl:     env.GOOGLE_MAPS_SCRAPER_URL ?? '',
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY ?? '',
    socrataAppToken:    env.SOCRATA_APP_TOKEN ?? '',
    registryReverseStatewide:
      (env.REGISTRY_REVERSE_STATEWIDE ?? '').trim().toLowerCase() === 'true',
    registryDatabaseUrl: env.REGISTRY_DATABASE_URL ?? '',
    registryMaxDbMb: Number(env.REGISTRY_MAX_DB_MB ?? 20_000),
    // Default off: measured on the 75-business benchmark as zero recovery for
    // 2.6x the verification spend. See EXTRA_PATTERN_ORDER in lib/patterns.ts.
    patternLadderExtras:
      (env.PATTERN_LADDER_EXTRAS ?? '').trim().toLowerCase() === 'true',
    verify: {
      url:        env.VERIFY_URL ?? '',
      ips,
      heloDomain: env.VERIFY_HELO_DOMAIN ?? '',
      fromEmail:  env.VERIFY_FROM_EMAIL ?? '',
    },
    verifier,
    verifalia: {
      username: env.VERIFALIA_USERNAME ?? '',
      password: env.VERIFALIA_PASSWORD ?? '',
      maxCentsPerCampaign: Number(env.VERIFALIA_MAX_CENTS_PER_CAMPAIGN ?? 500),
    },
    linkedinAccounts: parseLinkedinAccounts(env.LINKEDIN_ACCOUNTS ?? ''),
    concurrency: Number(env.WORKER_CONCURRENCY ?? 5),
    logLevel: (env.LOG_LEVEL ?? 'info') as Config['logLevel'],
    metricsPort: Number(env.METRICS_PORT ?? 9100),
  }
}

/** Warnings collected by the last `loadConfig` call, for the boot log. */
export function degradedWarnings(): string[] {
  return (loadConfig as { lastDegraded?: string[] }).lastDegraded ?? []
}

/** Every variable name this codebase reads — used to generate the env table. */
export function declaredVars(): VarSpec[] {
  return SPECS
}
