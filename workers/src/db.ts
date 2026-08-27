// Two connection pools, on purpose.
//
// graphile-worker uses LISTEN/NOTIFY to wake instantly when a job is queued
// instead of polling. pgbouncer in *transaction* pooling mode hands a different
// backend connection to every transaction, so a LISTEN registered on one
// connection is never the one the NOTIFY arrives on — the listener silently
// receives nothing and the queue degrades to its polling interval. It does not
// crash, which is worse: it just gets slow and nobody knows why.
//
// So: the queue gets a session-mode connection (DATABASE_URL_DIRECT), and
// everything else goes through the pooler (DATABASE_URL), which is what makes
// scaling worker replicas affordable in the first place.

import pg from 'pg'
import type { Config } from './config.js'

const { Pool } = pg

export interface Db {
  /** Transaction pooling (:6543). Every application query goes here. */
  app: pg.Pool
  /**
   * **registry-db** — the local Postgres holding `registry_entities` and
   * `zip_county`. Null for every role that does not read them.
   *
   * A separate database rather than a schema, because the reason it moved was
   * Supabase's 500 MB free-plan ceiling: the registry is the one table that
   * grows without bound and the only one that is entirely internal — no RLS
   * policy references it, no Realtime subscription watches it, the frontend has
   * never read it.
   *
   * The boundary is clean by construction. `registry:match` reads a lead from
   * `app`, asks `registry` about it, and writes the verdict back to `app`;
   * there is no query that joins across the two, and there was none before the
   * split either.
   */
  registry: pg.Pool | null
  close(): Promise<void>
}

/**
 * Session-mode connections are a scarce, shared resource.
 *
 * Supavisor allows only 15 session clients for the whole project — measured the
 * hard way, when the sixth worker crash-looped on
 * `(EMAXCONNSESSION) max clients reached in session mode`. graphile-worker
 * needs session mode for LISTEN/NOTIFY, so the budget is spent almost entirely
 * on queue listeners and there is none to spare for an application pool.
 *
 * Hence: no long-lived session pool here at all. Application queries use the
 * transaction pooler, which has a far larger client allowance, and the queue
 * gets a small fixed session allocation set in index.ts.
 */
export const SESSION_POOL_LIMIT = 15
export const SESSION_CONNS_PER_WORKER = 2

export function createDb(config: Config): Db {
  const app = new Pool({
    connectionString: config.databaseUrl,
    max: Math.max(3, Math.min(config.concurrency + 1, 8)),
    // Transaction pooling cannot use server-side prepared statements.
    // node-postgres only prepares named queries, and we issue none — this is a
    // note for anyone tempted to add one.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `leadgen-worker-${config.role}`,
  })

  // An unhandled 'error' on an idle client takes the process down.
  app.on('error', err => {
    console.error(JSON.stringify({ level: 'error', message: 'pg app pool error', err: err.message }))
  })

  // Only the registry role talks to registry-db. Opening the pool everywhere
  // would mean every worker holding connections to a database it never queries,
  // and would make a registry-db outage look like a fleet-wide failure.
  const wantsRegistry = config.role === 'registry' || config.role === 'all'
  let registry: pg.Pool | null = null

  if (wantsRegistry && config.registryDatabaseUrl) {
    registry = new Pool({
      connectionString: config.registryDatabaseUrl,
      // Local container, not a shared pooler: there is no 15-client budget to
      // respect here, so this is sized for the ingest's batching rather than
      // rationed.
      max: Math.max(4, Math.min(config.concurrency + 2, 10)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: `leadgen-registry-${config.role}`,
    })
    registry.on('error', err => {
      console.error(JSON.stringify({
        level: 'error', message: 'pg registry pool error', err: err.message,
      }))
    })
  }

  return {
    app,
    registry,
    async close() {
      await app.end().catch(() => {})
      await registry?.end().catch(() => {})
    },
  }
}

/**
 * Confirm registry-db is reachable and carries the schema we expect.
 *
 * Checked at boot rather than on the first job, because the failure mode
 * otherwise is a `registry:match` that throws once per lead across a whole
 * campaign — 1,042 identical errors that say "relation does not exist" and
 * nothing about which database is missing it.
 */
export async function assertRegistryDb(db: Db, config: Config): Promise<void> {
  if (!db.registry) return
  try {
    const { rows } = await db.registry.query<{ n: string }>(
      `select count(*) n from registry_entities`)
    console.error(JSON.stringify({
      level: 'info',
      message: 'registry-db connected',
      entities: Number(rows[0]?.n ?? 0),
    }))
  } catch (err) {
    throw new Error(
      'REGISTRY_DATABASE_URL is set but registry-db is not usable: ' +
      `${(err as Error).message}. The registry moved out of Supabase — see ` +
      'infra/registry-db/schema.sql. Start it with `docker compose up -d ' +
      'registry-db`; the schema is applied on first boot from the mounted file.',
    )
  }
}

/**
 * Confirm both connection strings really do point at the modes we assume.
 *
 * `pgbouncer` in transaction mode refuses `LISTEN`, so this is a cheap way to
 * catch the single most likely misconfiguration — both variables set to the
 * same pooled URL — at boot rather than as mysteriously slow job pickup.
 */
export async function assertConnectionModes(config: Config): Promise<void> {
  // A single short-lived client, not a pool: this runs once at boot and must
  // not hold one of the 15 session slots for the process lifetime.
  const client = new pg.Client({
    connectionString: config.databaseUrlDirect,
    connectionTimeoutMillis: 15_000,
    application_name: `leadgen-boot-${config.role}`,
  })
  try {
    await client.connect()
    await client.query('LISTEN leadgen_boot_probe')
    await client.query('UNLISTEN leadgen_boot_probe')
  } catch (err) {
    const message = (err as Error).message
    if (/EMAXCONNSESSION|max clients reached/i.test(message)) {
      throw new Error(
        'Session-mode connection budget is exhausted. Supavisor allows ~' +
        `${SESSION_POOL_LIMIT} session clients per project and every worker needs ` +
        `about ${SESSION_CONNS_PER_WORKER} for graphile-worker's LISTEN/NOTIFY. ` +
        'Run fewer worker replicas, or raise the pool size in the Supabase ' +
        `dashboard. Underlying error: ${message}`,
      )
    }
    throw new Error(
      'DATABASE_URL_DIRECT does not support LISTEN/NOTIFY — it looks like a ' +
      'transaction-mode URL. graphile-worker needs session mode (Supabase: the ' +
      `:5432 pooler, not :6543). Underlying error: ${message}`,
    )
  } finally {
    await client.end().catch(() => {})
  }
}
