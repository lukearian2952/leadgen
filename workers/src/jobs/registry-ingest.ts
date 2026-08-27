// registry:ingest — pull a scoped slice of a state registry into
// `registry_entities`.
//
// Scoped, not whole-state, and deliberately so. NY is 4.27M rows and Nassau
// county alone is 405,947; ingesting a state to answer 75 questions is the
// wrong shape. A campaign's scope is its counties plus the niche's name tokens,
// which for "med spa on Long Island" is a few thousand entities.
//
// The scoped slice is not the only coverage, though — it cannot be, because the
// token list is a guess about how businesses name themselves. `registry:match`
// tops it up per lead with a one-request lookup on that lead's own distinctive
// tokens, so a "Brizel Med Spa" is found by BRIZEL even when the slice only
// asked for SPA. Bulk gives cheap breadth; the top-up gives correctness.

import type { Task } from 'graphile-worker'
import { wrapTask } from './wrap.js'
import { requireRegistryDb, type TaskDeps } from './index.js'
import type { Pool } from 'pg'
import { adapterFor, upsertEntities, type IngestScope, type RegistryEntity } from '../sources/registry/index.js'

interface Payload {
  state: string
  counties?: string[]
  nameContains?: string[]
  limit?: number
  /** FL only: 'daily' (default) or 'quarterly'. */
  mode?: string
  days?: number
  /**
   * Keep entities that name nobody. Default false — see `UpsertOptions`.
   * Set true only for a coverage audit that needs the whole slice.
   */
  keepAnonymous?: boolean
  /** Keep the per-adapter `raw` payload. Default false on a bulk ingest. */
  keepRaw?: boolean
  /**
   * Load the entire state rather than a niche-scoped slice.
   *
   * Requires `nameContains` to be empty and is recorded, so the weekly refresh
   * can tell a deliberate whole-state load from a scope that went missing.
   */
  wholeState?: boolean
  /** Rows per upstream request. See `IngestScope.pageSize`. */
  pageSize?: number
  /**
   * Rows per upsert statement.
   *
   * 500 × 14 columns is 7,000 bind parameters; Postgres allows 65,535, so
   * there is room. Raised only for whole-state ingests, where the round trip
   * rather than the statement is the cost.
   */
  batchSize?: number
  [key: string]: unknown
}

/** Rows per upsert. Large enough to amortise the round trip, small enough that
 *  one bad batch does not lose an hour of paging. */
const BATCH = 500

/** Batches between database-size checks. `pg_database_size` is not free. */
const SIZE_CHECK_EVERY = 20

/** States whose adapter goes through Socrata and so shares its throttle pool. */
const SOCRATA_STATES = new Set(['NY', 'CO', 'OR', 'CT'])

/**
 * Thrown when the ingest stops because the database is full rather than
 * because the slice ended. Distinguished from a crash so the caller can tell
 * "we have all of FL" from "we have as much of FL as fits".
 */
export class RegistryBudgetExceeded extends Error {
  constructor(readonly usedMb: number, readonly capMb: number, readonly written: number) {
    super(
      `registry ingest stopped at ${usedMb} MB of a ${capMb} MB ceiling after ` +
      `${written} rows. Supabase's free plan stops at 500 MB and a project that ` +
      'reaches it goes read-only, which would take down the fleet and not just ' +
      'this job. Raise REGISTRY_MAX_DB_MB only alongside more disk.')
  }
}

async function databaseMb(registryDb: Pool): Promise<number> {
  const { rows } = await registryDb.query<{ mb: string }>(
    'select round(pg_database_size(current_database()) / 1048576.0) mb')
  return Number(rows[0]?.mb ?? 0)
}

export function makeRegistryIngestTask(deps: TaskDeps): Task {
  const { config, db } = deps
  // Entities are written to registry-db; `db` keeps the job bookkeeping that
  // every other stage also writes, so a run stays visible in one place.
  const registryDb = requireRegistryDb(deps)

  return wrapTask<Payload>({ stage: 'registry:ingest', db }, async (payload, ctx) => {
    const state = (payload.state ?? '').toUpperCase()
    const adapter = adapterFor(state, config, ctx.logger)
    if (!adapter) throw new Error(`no registry adapter for state "${payload.state}"`)

    if (!config.socrataAppToken && SOCRATA_STATES.has(state)) {
      ctx.logger.warn(
        'SOCRATA_APP_TOKEN is not set — requests share the anonymous throttle pool. ' +
        'Free from evergreen.data.socrata.com/signup; ingest will be slower and may 429.')
    }

    const wholeState = payload.wholeState === true
    if (wholeState && (payload.nameContains ?? []).length) {
      throw new Error(
        'wholeState and nameContains are mutually exclusive — a whole-state ' +
        'ingest is by definition unscoped. Drop one.')
    }

    const scope: IngestScope & Record<string, unknown> = {
      counties: payload.counties ?? [],
      nameContains: payload.nameContains ?? [],
      limit: payload.limit,
      pageSize: payload.pageSize,
      mode: payload.mode,
      days: payload.days,
    }

    const upsertOptions = {
      personOnly: payload.keepAnonymous !== true,
      trimRaw:    payload.keepRaw !== true,
    }

    const capMb = config.registryMaxDbMb
    const startMb = await databaseMb(registryDb)
    if (capMb > 0 && startMb >= capMb) {
      throw new RegistryBudgetExceeded(startMb, capMb, 0)
    }

    let seen = 0, written = 0, withPerson = 0, skippedAnonymous = 0
    let batches = 0
    let batch: RegistryEntity[] = []
    let budgetStop = false

    const flush = async () => {
      if (!batch.length) return
      const stats = await upsertEntities(registryDb, batch, upsertOptions)
      seen += stats.seen; written += stats.written; withPerson += stats.withPerson
      skippedAnonymous += stats.skippedAnonymous
      batch = []

      // Checked mid-ingest rather than only at the end: a whole-state slice is
      // millions of rows and the point of the ceiling is to stop before the
      // project goes read-only, not to report afterwards that it did.
      if (capMb > 0 && ++batches % SIZE_CHECK_EVERY === 0) {
        const mb = await databaseMb(registryDb)
        ctx.logger.info('registry ingest size check', { mb, capMb, written })
        if (mb >= capMb) budgetStop = true
      }
    }

    const batchSize = Math.max(100, Math.min(payload.batchSize ?? BATCH, 4_000))

    for await (const entity of adapter.ingest(scope)) {
      batch.push(entity)
      if (batch.length >= batchSize) {
        await flush()
        if (budgetStop) break
      }
    }
    if (!budgetStop) await flush()

    const endMb = await databaseMb(registryDb)
    ctx.cost.detail = {
      state, adapter: adapter.name,
      // Recorded because it was not, and its absence was a live bug: the weekly
      // refresh read `mode` back out of this payload, found null for FL, and
      // would have re-ingested a whole-state quarterly slice as five business
      // days of daily filings.
      mode: payload.mode ?? null,
      seen, written,
      with_person: withPerson,
      skipped_anonymous: skippedAnonymous,
      person_rate: seen ? Number((withPerson / seen).toFixed(3)) : 0,
      counties: scope.counties, name_contains: scope.nameContains,
      whole_state: wholeState,
      page_size: scope.pageSize ?? 1000, batch_size: batchSize,
      db_mb_start: startMb, db_mb_end: endMb, db_cap_mb: capMb,
      // The difference between "this state is loaded" and "this state is
      // loaded as far as the disk allowed". Every consumer of coverage
      // numbers needs to know which one it is looking at.
      complete: !budgetStop,
    }
    ctx.logger.info('registry ingest complete', ctx.cost.detail)

    // Record the scope beside the data it describes. `registry:refresh` reads
    // this rather than Supabase's `job_runs`, so the refresh needs exactly one
    // connection and cannot drift from what is actually loaded.
    await registryDb.query(
      `insert into registry_ingest_runs
         (state, adapter, mode, name_contains, counties,
          seen, written, with_person, skipped_anonymous, complete, db_mb_end,
          whole_state, finished_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       on conflict (state) do update
         set adapter = excluded.adapter, mode = excluded.mode,
             name_contains = excluded.name_contains, counties = excluded.counties,
             whole_state = excluded.whole_state,
             seen = excluded.seen, written = excluded.written,
             with_person = excluded.with_person,
             skipped_anonymous = excluded.skipped_anonymous,
             complete = excluded.complete, db_mb_end = excluded.db_mb_end,
             finished_at = now()`,
      [state, adapter.name, payload.mode ?? null,
       scope.nameContains ?? [], scope.counties ?? [],
       seen, written, withPerson, skippedAnonymous, !budgetStop, endMb, wholeState])

    if (budgetStop) throw new RegistryBudgetExceeded(endMb, capMb, written)
  })
}

/**
 * Name tokens worth pulling for a niche.
 *
 * These decide the breadth of the bulk slice only; per-lead top-up lookups do
 * not depend on them, so an incomplete list costs a little extra API traffic
 * rather than any coverage.
 */
export function nicheNameTokens(niche: string): string[] {
  const n = (niche ?? '').toLowerCase()
  if (/med ?spa|medspa|aesthetic|derm|botox|laser|skin/.test(n)) {
    return ['SPA', 'AESTHETIC', 'ESTHETIC', 'SKIN', 'LASER', 'DERM', 'BEAUTY',
            'COSMETIC', 'REJUV', 'GLOW', 'WELLNESS', 'MEDI', 'BOTOX', 'INJECT']
  }
  if (/dent/.test(n))        return ['DENTAL', 'DENTIST', 'ORTHO', 'SMILE', 'ORAL']
  if (/chiro/.test(n))       return ['CHIRO', 'SPINE', 'WELLNESS']
  if (/plumb/.test(n))       return ['PLUMB', 'ROOTER', 'DRAIN', 'SEWER']
  if (/law|attorney/.test(n))return ['LAW', 'LEGAL', 'ATTORNEY', 'COUNSEL']
  if (/salon|hair/.test(n))  return ['SALON', 'HAIR', 'BEAUTY', 'STUDIO', 'BARBER']
  // Deliberately narrow. The generic fallback below would yield VEHICLE, WRAP
  // and SHOP — and "SHOP" statewide matches every barbershop, coffee shop and
  // print shop in New York, which is a slow query returning almost nothing
  // useful. WRAP and the sign/graphics trade words are what these businesses
  // actually register under.
  if (/wrap|vinyl|tint|graphic|decal|ppf|paint protection/.test(n)) {
    return ['WRAP', 'VINYL', 'GRAPHIC', 'SIGN', 'TINT', 'DECAL', 'CUSTOM AUTO',
            'AUTO SPA', 'DETAIL']
  }
  // A single broad token beats no filter at all, which for NY is 4.27M rows.
  const words = n.split(/\s+/).filter(w => w.length >= 4)
  return words.length ? words.map(w => w.toUpperCase()) : ['LLC']
}
