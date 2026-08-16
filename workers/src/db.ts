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

  return { app, async close() { await app.end().catch(() => {}) } }
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
