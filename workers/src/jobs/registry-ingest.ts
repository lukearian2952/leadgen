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
import type { TaskDeps } from './index.js'
import { adapterFor, upsertEntities, type IngestScope, type RegistryEntity } from '../sources/registry/index.js'

interface Payload {
  state: string
  counties?: string[]
  nameContains?: string[]
  limit?: number
  /** FL only: 'daily' (default) or 'quarterly'. */
  mode?: string
  days?: number
  [key: string]: unknown
}

/** Rows per upsert. Large enough to amortise the round trip, small enough that
 *  one bad batch does not lose an hour of paging. */
const BATCH = 500

export function makeRegistryIngestTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'registry:ingest', db }, async (payload, ctx) => {
    const state = (payload.state ?? '').toUpperCase()
    const adapter = adapterFor(state, config, ctx.logger)
    if (!adapter) throw new Error(`no registry adapter for state "${payload.state}"`)

    if (!config.socrataAppToken && (state === 'NY' || state === 'CO')) {
      ctx.logger.warn(
        'SOCRATA_APP_TOKEN is not set — requests share the anonymous throttle pool. ' +
        'Free from evergreen.data.socrata.com/signup; ingest will be slower and may 429.')
    }

    const scope: IngestScope & Record<string, unknown> = {
      counties: payload.counties ?? [],
      nameContains: payload.nameContains ?? [],
      limit: payload.limit,
      mode: payload.mode,
      days: payload.days,
    }

    let seen = 0, written = 0, withPerson = 0
    let batch: RegistryEntity[] = []

    const flush = async () => {
      if (!batch.length) return
      const stats = await upsertEntities(db, batch)
      seen += stats.seen; written += stats.written; withPerson += stats.withPerson
      batch = []
      ctx.logger.info('registry ingest progress', { state, seen, written, withPerson })
    }

    for await (const entity of adapter.ingest(scope)) {
      batch.push(entity)
      if (batch.length >= BATCH) await flush()
    }
    await flush()

    ctx.cost.detail = {
      state, adapter: adapter.name, seen, written,
      with_person: withPerson,
      person_rate: seen ? Number((withPerson / seen).toFixed(3)) : 0,
      counties: scope.counties, name_contains: scope.nameContains,
    }
    ctx.logger.info('registry ingest complete', ctx.cost.detail)
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
