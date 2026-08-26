// Adapter selection and the shared upsert.

import type { Pool } from 'pg'
import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'
import type { RegistryAdapter, RegistryEntity } from './types.js'
import { NyRegistry } from './ny.js'
import { CoRegistry } from './co.js'
import { FlRegistry } from './fl.js'
import { OrRegistry } from './or.js'
import { CtRegistry } from './ct.js'

export * from './types.js'
export { NyRegistry } from './ny.js'
export { CoRegistry } from './co.js'
export { FlRegistry } from './fl.js'
export { OrRegistry } from './or.js'
export { CtRegistry } from './ct.js'

export const SUPPORTED_STATES = ['NY', 'FL', 'CO', 'OR', 'CT'] as const
export type SupportedState = typeof SUPPORTED_STATES[number]

export function adapterFor(
  state: string, config: Config, logger: Logger,
): RegistryAdapter | null {
  switch (state.toUpperCase()) {
    case 'NY': return new NyRegistry(config.socrataAppToken, logger)
    case 'CO': return new CoRegistry(config.socrataAppToken, logger)
    case 'FL': return new FlRegistry(logger)
    case 'OR': return new OrRegistry(config.socrataAppToken, logger)
    case 'CT': return new CtRegistry(config.socrataAppToken, logger)
    default:   return null
  }
}

export interface UpsertStats {
  seen: number
  written: number
  withPerson: number
  /** Entities dropped before the insert because they name nobody. */
  skippedAnonymous: number
}

export interface UpsertOptions {
  /**
   * Drop entities with no person officer before writing them.
   *
   * An entity nobody is named on cannot produce a name by either direction:
   * the forward match reads `officers[0]` and the reverse match searches
   * `officers @> …`. Storing it buys nothing and costs a row. On NY that is
   * 61% of the slice, on CO 21%.
   *
   * Off by default so a caller that wants the complete picture — a coverage
   * audit, say — still gets it.
   */
  personOnly?: boolean
  /**
   * Drop the `raw` payload.
   *
   * `raw` is the evidence trail for a single adapter's field decisions and is
   * 30% of the table heap (16 MB of 54 MB at 100k rows). Worth keeping on a
   * dry run, not worth keeping on a bulk slice.
   */
  trimRaw?: boolean
}

/**
 * Upsert a batch of entities and record their ZIP→county observations.
 *
 * Batched into one multi-row statement rather than one round trip per entity:
 * a county-scoped NY slice is tens of thousands of rows, and at ~40 ms per
 * round trip over the pooler that is the difference between a minute and an
 * hour.
 */
export async function upsertEntities(
  db: Pool, entities: RegistryEntity[], options: UpsertOptions = {},
): Promise<UpsertStats> {
  const stats: UpsertStats = {
    seen: entities.length, written: 0, withPerson: 0, skippedAnonymous: 0,
  }
  if (!entities.length) return stats

  let admitted = entities
  if (options.personOnly) {
    admitted = entities.filter(e => e.officers.some(o => o.kind === 'person' && o.first))
    stats.skippedAnonymous = entities.length - admitted.length
  }

  // Duplicate entity ids inside one batch would make ON CONFLICT fire twice on
  // the same row in a single statement, which Postgres rejects outright
  // ("cannot affect row a second time"). Socrata paging under a stable $order
  // should not produce them, but a per-lead lookup overlapping the bulk slice
  // certainly can.
  const unique = new Map<string, RegistryEntity>()
  for (const e of admitted) {
    if (!e.entityId) continue
    unique.set(`${e.state}:${e.entityId}`, e)
  }
  const rows = [...unique.values()]

  // The crosswalk is built from every entity the adapter yielded, including the
  // ones `personOnly` just dropped. It is 832 kB per 100k entities and it is
  // what lets a Maps business — which has a ZIP and no county — be matched on
  // county at all, so throwing away a nameless entity's ZIP would trade a
  // valuable byte for a worthless one.
  await recordZipCounties(db, entities)

  if (!rows.length) return stats

  const cols = 14
  const values: unknown[] = []
  const tuples: string[] = []

  rows.forEach((e, i) => {
    const p = (n: number) => `$${i * cols + n}`
    tuples.push(
      `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},` +
      `${p(9)},${p(10)},${p(11)},${p(12)}::date,${p(13)}::jsonb,${p(14)}::jsonb)`)
    values.push(
      e.state, e.entityId, e.name, e.nameNorm, e.status, e.entityType,
      e.county, e.city, e.stateCode, e.postalCode, e.street,
      e.filingDate, JSON.stringify(e.officers),
      JSON.stringify(options.trimRaw ? {} : e.raw),
    )
    if (e.officers.length) stats.withPerson++
  })

  const { rowCount } = await db.query(
    `insert into registry_entities
       (state, entity_id, name, name_norm, status, entity_type,
        county, city, state_code, postal_code, street, filing_date, officers, raw)
     values ${tuples.join(',')}
     on conflict (state, entity_id) do update
       set name = excluded.name, name_norm = excluded.name_norm,
           status = excluded.status, entity_type = excluded.entity_type,
           county = excluded.county, city = excluded.city,
           state_code = excluded.state_code, postal_code = excluded.postal_code,
           street = excluded.street, filing_date = excluded.filing_date,
           officers = excluded.officers, raw = excluded.raw,
           ingested_at = now()`,
    values,
  )
  stats.written = rowCount ?? 0

  return stats
}

/**
 * Record every (zip, county) pair the registry itself asserts.
 *
 * Aggregated in process and applied as one statement: at one round trip per row
 * a 40k-row county slice would spend an hour on bookkeeping.
 */
async function recordZipCounties(db: Pool, entities: RegistryEntity[]): Promise<void> {
  const tally = new Map<string, { zip: string; state: string; county: string; n: number }>()
  for (const e of entities) {
    const zip = e.postalCode.replace(/[^0-9]/g, '').slice(0, 5)
    if (!zip || !e.county) continue
    const key = `${zip}|${e.state}|${e.county}`
    const hit = tally.get(key)
    if (hit) hit.n++
    else tally.set(key, { zip, state: e.state, county: e.county, n: 1 })
  }

  const zc = [...tally.values()]
  if (!zc.length) return

  const zv: unknown[] = []
  const zt = zc.map((t, i) => {
    zv.push(t.zip, t.state.toUpperCase(), t.county, t.n)
    return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4}::int)`
  })
  await db.query(
    `insert into zip_county (postal_code, state, county, weight)
     values ${zt.join(',')}
     on conflict (postal_code, state, county)
       do update set weight = zip_county.weight + excluded.weight`,
    zv,
  )
}
