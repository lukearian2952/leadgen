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
  /** Pooled — pgbouncer transaction mode. Use for all application queries. */
  app: pg.Pool
  /** Session mode — reserved for graphile-worker's listener. */
  direct: pg.Pool
  close(): Promise<void>
}

export function createDb(config: Config): Db {
  const app = new Pool({
    connectionString: config.databaseUrl,
    max: Math.max(4, config.concurrency + 2),
    // pgbouncer cannot use server-side prepared statements in transaction mode.
    // node-postgres only prepares when a query has a `name`, so this is really
    // a reminder for anyone tempted to add one.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `leadgen-worker-${config.role}`,
  })

  const direct = new Pool({
    connectionString: config.databaseUrlDirect,
    // The listener needs one connection. A couple spare for the migrator.
    max: 3,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 10_000,
    application_name: `leadgen-queue-${config.role}`,
  })

  // An error on an idle client is emitted on the pool, and an unhandled 'error'
  // event on an EventEmitter takes the process down.
  app.on('error', err => { console.error(JSON.stringify({ level: 'error', message: 'pg app pool error', err: err.message })) })
  direct.on('error', err => { console.error(JSON.stringify({ level: 'error', message: 'pg direct pool error', err: err.message })) })

  return {
    app,
    direct,
    async close() {
      await Promise.allSettled([app.end(), direct.end()])
    },
  }
}

/**
 * Confirm both connection strings really do point at the modes we assume.
 *
 * `pgbouncer` in transaction mode refuses `LISTEN`, so this is a cheap way to
 * catch the single most likely misconfiguration — both variables set to the
 * same pooled URL — at boot rather than as mysteriously slow job pickup.
 */
export async function assertConnectionModes(db: Db): Promise<{ direct: 'session' | 'unknown' }> {
  const client = await db.direct.connect()
  try {
    await client.query('LISTEN leadgen_boot_probe')
    await client.query('UNLISTEN leadgen_boot_probe')
    return { direct: 'session' }
  } catch (err) {
    throw new Error(
      'DATABASE_URL_DIRECT does not support LISTEN/NOTIFY — it looks like a ' +
      'pgbouncer transaction-mode URL. graphile-worker needs a session-mode ' +
      'connection here (Supabase: the direct 5432 connection string, not the ' +
      `6543 pooler). Underlying error: ${(err as Error).message}`,
    )
  } finally {
    client.release()
  }
}
