// Connection helpers for the scripts in this directory.
//
// There are two databases now and the distinction matters in every script that
// touches the registry:
//
//   app       Supabase — campaigns, leads, businesses, job bookkeeping.
//   registry  registry-db — `registry_entities` and `zip_county`, on the VPS.
//
// The split happened because Supabase is on the free plan (500 MB, read-only
// past it) and the registry is the one table that grows without bound. It is
// also entirely internal: no RLS policy references it, no Realtime subscription
// watches it, the frontend has never read it.
//
// **There is no cross-database join.** Anything that used to select from
// `leads` and call `county_for_zip` in one statement now has to do it in two
// steps, and a script that quietly kept the single-statement form would return
// an empty result rather than an error.
//
// From the Mac, registry-db is reachable over the SSH tunnel or on
// `127.0.0.1:5433` when one is open; `REGISTRY_DATABASE_URL` should point at
// whichever applies. On the VPS it is `registry-db:5432` inside the compose
// network.

import pg from 'pg'

/** Supabase, through the transaction pooler. */
export function appPool(max = 2): pg.Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  return new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
}

/**
 * registry-db.
 *
 * No TLS: it is a container on a private bridge, or a local tunnel. Adding
 * `ssl` here would fail against a Postgres that was never given a certificate.
 */
export function registryPool(max = 2): pg.Pool {
  const connectionString = process.env.REGISTRY_DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'REGISTRY_DATABASE_URL is not set. The registries live in registry-db ' +
      'now, not Supabase — see infra/registry-db/schema.sql. From the Mac, ' +
      'open a tunnel first:\n' +
      '  ssh -N -L 5433:127.0.0.1:5433 <vps>\n' +
      'then REGISTRY_DATABASE_URL=postgres://registry:<pw>@127.0.0.1:5433/registry')
  }
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
}
