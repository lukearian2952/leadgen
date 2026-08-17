// Worker entrypoint.
//
// One container = one WORKER_ROLE = one set of registered task names. Scaling a
// stage is `--scale crawl-worker=4`; there is no in-process stage routing and
// no shared mutable state between replicas beyond Postgres.

// Side-effect import, first: installs Happy Eyeballs so a dead IPv6 route on
// the host cannot stall every outbound call. See src/net.ts.
import './net.js'

import { run, type Runner } from 'graphile-worker'
import { loadConfig, degradedWarnings, ConfigError } from './config.js'
import { createDb, assertConnectionModes, SESSION_CONNS_PER_WORKER, type Db } from './db.js'
import { rootLogger } from './logger.js'
import { startMetricsServer, metrics } from './metrics.js'
import { buildTaskList, stagesForRole } from './jobs/index.js'
import { applyMailboxFeedback, type FeedbackRequest } from './feedback.js'

async function main() {
  const config = loadConfig()
  const logger = rootLogger.child({ role: config.role })

  for (const warning of degradedWarnings()) {
    logger.warn(`optional config missing: ${warning}`)
  }

  logger.info('starting worker', {
    stages: stagesForRole(config.role),
    concurrency: config.concurrency,
    verifier: config.verifier,
  })

  const db: Db = createDb(config)

  // Catches the single most likely deployment mistake — both connection
  // strings pointing at the pgbouncer pooler — before it turns into
  // mysteriously slow job pickup rather than a visible failure.
  await assertConnectionModes(config)
  logger.info('DATABASE_URL_DIRECT confirmed session-mode (LISTEN/NOTIFY available)')

  let runner: Runner | undefined
  let healthy = false

  // The closed-loop feedback endpoint is owned by the verify role — it is the
  // one that already reasons about mailbox verdicts, and registering it on
  // every worker would give the same URL seven different ports.
  const postRoutes = config.role === 'verify' || config.role === 'all'
    ? [{
        path: '/feedback/mailbox',
        handle: async (body: unknown) => applyMailboxFeedback(db.app, body as FeedbackRequest),
      }]
    : []

  const metricsServer = startMetricsServer(config.metricsPort, () => ({
    healthy,
    detail: {
      role: config.role,
      stages: stagesForRole(config.role),
      concurrency: config.concurrency,
      postRoutes: postRoutes.map(r => r.path),
    },
  }), postRoutes)
  logger.info('metrics and health listening', { port: config.metricsPort })

  runner = await run({
    // graphile-worker needs the session-mode connection for LISTEN/NOTIFY.
    connectionString: config.databaseUrlDirect,
    concurrency: config.concurrency,
    // Session slots are a project-wide budget of ~15 across every worker, so
    // the queue gets a small fixed allocation rather than one-per-concurrency.
    // Without this the sixth worker crash-loops on EMAXCONNSESSION.
    maxPoolSize: SESSION_CONNS_PER_WORKER,
    // Its migrations create the graphile_worker schema on first boot.
    noHandleSignals: true,
    pollInterval: 2000,
    taskList: buildTaskList({ config, db: db.app, logger }),
  })

  healthy = true
  logger.info('worker ready')

  // Queue depth for the jobs dashboard. Cheap query, low frequency.
  const depthTimer = setInterval(() => {
    void db.app.query<{ count: string }>(
      `select count(*)::text from graphile_worker.jobs
        where run_at <= now() and locked_at is null`,
    ).then(({ rows }) => {
      metrics.queueDepth.set({}, Number(rows[0]?.count ?? 0))
    }).catch(() => { /* table may not exist until first migration */ })
  }, 15_000)

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal })
    healthy = false
    clearInterval(depthTimer)
    try {
      await runner?.stop()
    } catch (err) {
      logger.error('runner stop failed', err)
    }
    metricsServer.close()
    await db.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await runner.promise
}

main().catch(err => {
  if (err instanceof ConfigError) {
    // A config error is an operator problem, not a stack trace.
    process.stderr.write(`\n[config] ${err.message}\n\n`)
    process.exit(78) // EX_CONFIG
  }
  rootLogger.error('worker crashed', err)
  process.exit(1)
})
