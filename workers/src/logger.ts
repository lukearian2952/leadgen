// Structured JSON logs, one object per line.
//
// Workers run as Docker replicas; whatever ships logs off the box needs to be
// able to parse them without a grok pattern. Every line carries the worker
// role and, where known, the campaign and lead so a single campaign's trail can
// be pulled out of a fleet-wide stream.

export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogContext {
  role?: string
  campaignId?: string
  leadId?: string
  stage?: string
  jobId?: string
  [key: string]: unknown
}

export class Logger {
  constructor(
    private readonly minLevel: Level = 'info',
    private readonly base: LogContext = {},
  ) {}

  /** Derive a logger that stamps extra context on every line. */
  child(extra: LogContext): Logger {
    return new Logger(this.minLevel, { ...this.base, ...extra })
  }

  private emit(level: Level, message: string, extra?: LogContext) {
    if (ORDER[level] < ORDER[this.minLevel]) return
    const line = {
      ts: new Date().toISOString(),
      level,
      message,
      ...this.base,
      ...extra,
    }
    // Errors to stderr so container runtimes can split the streams.
    const out = level === 'error' ? process.stderr : process.stdout
    out.write(JSON.stringify(line, replacer) + '\n')
  }

  debug(message: string, extra?: LogContext) { this.emit('debug', message, extra) }
  info(message: string, extra?: LogContext)  { this.emit('info', message, extra) }
  warn(message: string, extra?: LogContext)  { this.emit('warn', message, extra) }

  error(message: string, err?: unknown, extra?: LogContext) {
    this.emit('error', message, {
      ...extra,
      ...(err instanceof Error
        ? { err: err.message, stack: err.stack }
        : err !== undefined ? { err: String(err) } : {}),
    })
  }
}

/**
 * Never log a credential, even by accident. Worker payloads carry proxy
 * passwords and li_at cookies, and a JSON.stringify of a config object would
 * otherwise put them straight into the log stream.
 */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|li_at|cookie|authorization/i

function replacer(key: string, value: unknown) {
  if (SECRET_KEY.test(key) && typeof value === 'string' && value.length > 0) {
    return '[redacted]'
  }
  return value
}

export const rootLogger = new Logger(
  (process.env.LOG_LEVEL as Level) ?? 'info',
  { role: process.env.WORKER_ROLE ?? 'all' },
)
