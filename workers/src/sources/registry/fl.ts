// Florida — Sunbiz corporate data, `sftp.floridados.gov`.
//
// ── What was verified live, 2026-08-17 ───────────────────────────────────────
//
// Public SFTP, credentials published by the Division of Corporations on its own
// Data Downloads page (user `Public`). Directory layout confirmed by listing:
//
//   doc/cor/yyyymmddc.txt          daily filings, ~1.8 MB, plain text
//   doc/Quarterly/Cor/cordata.zip  full snapshot, 1,819,049,954 bytes
//
// `doc/cor/20260815c.txt` was downloaded and parsed against the published
// layout at dos.sunbiz.org/data-definitions/cor.html: 1,292 records, **every
// line exactly 1,440 characters**, every field landing where the spec says.
//
// ── Two things the spec does not tell you ────────────────────────────────────
//
// 1. **Each officer carries a P/C type flag** (offsets 673, 801, …). On the
//    sample day: 1,553 persons and 94 companies across the officer slots, and
//    899/393 for registered agents. The source answers person-vs-company
//    itself, which NY forces us to infer. That flag is trusted.
//
// 2. **Person names are two fixed sub-fields, not "First Last".** The 42-char
//    name slot is a 20-char space-padded last name followed by the first name:
//    `"JOVER               DANIELLA"` is Daniella Jover. Splitting on
//    whitespace — the obvious reading — inverts the name on every Florida row.
//    See splitFloridaName in lib/registry-name.ts.
//
// This makes FL the richest of the three adapters: six officer slots with
// titles, versus NY's three loosely-typed name columns and CO's single agent.
// 1,202 of 1,292 daily records (93%) name at least one officer.
//
// ── Access mode ──────────────────────────────────────────────────────────────
//
// `daily` streams recent daily files. Small, fast, and what the scheduled
// refresh uses.
//
// `quarterly` pulls the 1.8 GB snapshot. It is opt-in per job and checks free
// disk first, because this box also runs Odoo, n8n and three Postgres
// instances and filling its disk would take out production workloads that have
// nothing to do with lead generation. Members are streamed through `unzip -p`
// rather than extracted, so only the archive itself ever touches disk.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'

import type { RegistryAdapter, RegistryEntity, RegistryOfficer, IngestScope } from './types.js'
import { splitFloridaName, FL_TITLE_CODES, FL_OWNER_GRADE_CODES, isCommercialAgent } from '../../lib/registry-name.js'
import { normaliseName } from '../../lib/normalise.js'
import { checkFirstName } from '../../lib/identity.js'
import type { Logger } from '../../logger.js'

const HOST = 'sftp.floridados.gov'
const USER = 'Public'
/**
 * Published by the State of Florida on dos.fl.gov as the credential for public
 * bulk data. It is a distribution channel, not a secret, which is why it is a
 * constant here rather than an environment variable — an operator who has to
 * find and set it will assume it is theirs to obtain.
 */
const PASSWORD = 'PubAccess1845!'

const RECORD_LENGTH = 1440
/** Offsets are 1-based in the published spec; converted on read. */
const F = (line: string, start: number, len: number) => line.substr(start - 1, len).trim()

/** Officer slot n starts here and repeats every 128 chars. */
const OFFICER_BASE = 669
const OFFICER_STRIDE = 128
const OFFICER_SLOTS = 6

export type FlMode = 'daily' | 'quarterly'

export interface FlOptions extends IngestScope {
  mode?: FlMode
  /** How many recent daily files to read in `daily` mode. */
  days?: number
  /** Refuse `quarterly` unless this many GB are free. */
  requireFreeGb?: number
}

export class FlRegistry implements RegistryAdapter {
  readonly state = 'FL'
  readonly name = 'fl_sunbiz'

  constructor(private readonly logger: Logger) {}

  async *ingest(scope: FlOptions): AsyncIterable<RegistryEntity> {
    const mode = scope.mode ?? 'daily'
    if (mode === 'quarterly') {
      yield* this.ingestQuarterly(scope)
      return
    }
    yield* this.ingestDaily(scope)
  }

  // ── daily ──────────────────────────────────────────────────────────────────

  private async *ingestDaily(scope: FlOptions): AsyncIterable<RegistryEntity> {
    const days = scope.days ?? 5
    const files = recentDailyFiles(days)
    const dir = await mkdtemp(join(tmpdir(), 'flsunbiz-'))

    try {
      // One SFTP session for all of them: each connection costs a handshake
      // and the state's host is not fast.
      const commands = files.map(f => `-get doc/cor/${f} ${join(dir, f)}`).join('\n')
      await this.sftp(`${commands}\nbye\n`)

      let yielded = 0
      for (const file of files) {
        const path = join(dir, file)
        try { await stat(path) } catch { continue }  // `-get` tolerates absences
        for await (const line of readLines(path)) {
          if (line.length < RECORD_LENGTH) continue
          const entity = parseRecord(line)
          if (!matchesScope(entity, scope)) continue
          yield entity
          if (scope.limit && ++yielded >= scope.limit) return
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ── quarterly ──────────────────────────────────────────────────────────────

  private async *ingestQuarterly(scope: FlOptions): AsyncIterable<RegistryEntity> {
    const requireFreeGb = scope.requireFreeGb ?? 8
    const free = await freeGb(tmpdir())
    if (free < requireFreeGb) {
      throw new Error(
        `FL quarterly ingest needs ${requireFreeGb} GB free in ${tmpdir()} and found ` +
        `${free.toFixed(1)} GB. The archive alone is 1.8 GB and this host also runs ` +
        'Odoo, n8n and three Postgres instances — refusing rather than filling the disk.')
    }

    const dir = await mkdtemp(join(tmpdir(), 'flsunbiz-q-'))
    const archive = join(dir, 'cordata.zip')
    try {
      this.logger.info('fl quarterly download starting', { archive, freeGb: free })
      await this.sftp(`get doc/Quarterly/Cor/cordata.zip ${archive}\nbye\n`, 60 * 60_000)
      const size = (await stat(archive)).size
      this.logger.info('fl quarterly downloaded', { bytes: size })

      let yielded = 0
      for (const member of await listZipMembers(archive)) {
        // `unzip -p` writes one member to stdout, so the expanded text — several
        // GB across all ten members — never lands on disk.
        for await (const line of unzipLines(archive, member)) {
          if (line.length < RECORD_LENGTH) continue
          const entity = parseRecord(line)
          if (!matchesScope(entity, scope)) continue
          yield entity
          if (scope.limit && ++yielded >= scope.limit) return
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * FL's unit of access is a whole file, so a per-business lookup would mean
   * re-reading the archive. Callers get nothing here and fall back to whatever
   * the scheduled ingest already loaded — which is why the FL ingest is scoped
   * by city rather than by name.
   */
  lookup = undefined

  private sftp(script: string, timeoutMs = 10 * 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('sshpass', [
        '-e', 'sftp',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=30',
        '-o', 'PreferredAuthentications=password',
        `${USER}@${HOST}`,
      ], { env: { ...process.env, SSHPASS: PASSWORD }, stdio: ['pipe', 'pipe', 'pipe'] })

      let stderr = ''
      child.stderr.on('data', d => { stderr += String(d) })
      child.stdout.resume()

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`sunbiz sftp timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.on('error', err => {
        clearTimeout(timer)
        reject(new Error(
          `sunbiz sftp could not start (${err.message}). The worker image needs ` +
          'openssh-client and sshpass — see workers/Dockerfile.'))
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`sunbiz sftp exited ${code}: ${stderr.slice(-500)}`))
      })

      child.stdin.write(script)
      child.stdin.end()
    })
  }
}

// ── record parsing ───────────────────────────────────────────────────────────

/**
 * One 1,440-char corporate record → a RegistryEntity.
 *
 * Exported for tests: the layout is the kind of thing that is either exactly
 * right or silently produces plausible garbage, so it is asserted against real
 * bytes rather than trusted.
 */
export function parseRecord(line: string): RegistryEntity {
  const entityName = F(line, 13, 192)
  const officers: RegistryOfficer[] = []

  for (let slot = 0; slot < OFFICER_SLOTS; slot++) {
    const base = OFFICER_BASE + slot * OFFICER_STRIDE
    const code = F(line, base, 4).toUpperCase()
    const kindFlag = F(line, base + 4, 1).toUpperCase()
    const nameField = line.substr(base + 4, 42)
    if (!nameField.trim()) continue

    // 'C' is the file's own "this officer is a company" flag. Believe it.
    if (kindFlag === 'C') continue

    const { first, last } = splitFloridaName(nameField)
    if (!first || !last) continue
    if (checkFirstName(first)) continue
    if (isCommercialAgent(`${first} ${last}`)) continue

    officers.push({
      name: `${first} ${last}`,
      title: FL_TITLE_CODES[code] ?? code,
      first, last,
      kind: 'person',
      source_field: `officer_${slot + 1}`,
      // Owner-grade codes rank ahead of the rest, then by slot order.
      rank: (FL_OWNER_GRADE_CODES.has(code) ? 1 : 5) + slot * 0.01,
    })
  }

  // The registered agent is the fallback, behind every named officer.
  const raKind = F(line, 587, 1).toUpperCase()
  const raField = line.substr(544, 42)
  if (raKind === 'P' && raField.trim()) {
    const { first, last } = splitFloridaName(raField)
    if (first && last && !checkFirstName(first) && !isCommercialAgent(`${first} ${last}`)) {
      officers.push({
        name: `${first} ${last}`, title: 'Registered Agent',
        first, last, kind: 'person', source_field: 'registered_agent', rank: 8,
      })
    }
  }

  officers.sort((a, b) => a.rank - b.rank)

  const filed = F(line, 473, 8)   // yyyymmdd
  return {
    state: 'FL',
    entityId: F(line, 1, 12),
    name: entityName,
    nameNorm: normaliseName(entityName),
    status: F(line, 205, 1) === 'A' ? 'Active' : 'Inactive',
    entityType: F(line, 206, 15),
    // FL publishes no county; resolved from the ZIP at match time.
    county: '',
    city: F(line, 305, 28),
    // The state column is blank on Florida-domestic records; the address is FL.
    stateCode: F(line, 333, 2) || 'FL',
    postalCode: F(line, 335, 10),
    street: F(line, 221, 42),
    filingDate: /^\d{8}$/.test(filed)
      ? `${filed.slice(0, 4)}-${filed.slice(4, 6)}-${filed.slice(6, 8)}`
      : null,
    officers,
    raw: { filing_type: F(line, 206, 15), fei: F(line, 481, 14) },
  }
}

function matchesScope(entity: RegistryEntity, scope: FlOptions): boolean {
  if (scope.nameContains?.length) {
    const upper = entity.name.toUpperCase()
    if (!scope.nameContains.some(t => upper.includes(t.toUpperCase()))) return false
  }
  return true
}

/** `yyyymmddc.txt` for the last `days` weekdays. Sunbiz files only on work days. */
export function recentDailyFiles(days: number, now = new Date()): string[] {
  const out: string[] = []
  const cursor = new Date(now)
  // Yesterday at the earliest — today's file may not be published yet.
  cursor.setUTCDate(cursor.getUTCDate() - 1)
  while (out.length < days) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      const y = cursor.getUTCFullYear()
      const m = String(cursor.getUTCMonth() + 1).padStart(2, '0')
      const d = String(cursor.getUTCDate()).padStart(2, '0')
      out.push(`${y}${m}${d}c.txt`)
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return out
}

// ── streaming helpers ────────────────────────────────────────────────────────

async function *readLines(path: string): AsyncIterable<string> {
  // latin1, not utf8: the file is fixed-width bytes and a multi-byte decode
  // would shift every offset after the first non-ASCII character.
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) yield line
}

async function *unzipLines(archive: string, member: string): AsyncIterable<string> {
  const child = spawn('unzip', ['-p', archive, member], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('latin1')
  let stderr = ''
  child.stderr.on('data', d => { stderr += String(d) })

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } finally {
    child.kill()
  }
  if (stderr.trim()) throw new Error(`unzip ${member}: ${stderr.slice(-300)}`)
}

function listZipMembers(archive: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-Z1', archive])
    let out = '', err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`unzip -Z1 exited ${code}: ${err}`))
      resolve(out.split('\n').map(s => s.trim()).filter(Boolean))
    })
  })
}

const statfsAsync = promisify(statfs)

async function freeGb(path: string): Promise<number> {
  try {
    const fs = await statfsAsync(path)
    return (Number(fs.bavail) * Number(fs.bsize)) / 1e9
  } catch {
    return Number.POSITIVE_INFINITY   // cannot check ⇒ do not block on it
  }
}
