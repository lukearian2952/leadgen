// Prove a registry adapter against live data without writing anything.
//
// Every adapter in this fleet is a bet about a published layout, and the FL
// experience is the reason this exists: the spec omitted both the officer
// person/company flag and the fixed-width name split, and the obvious reading
// inverted every Florida name into plausible garbage. So a new adapter is read
// out loud against real records before a single row is stored.
//
// Usage: npx tsx scripts/adapter-probe.ts <STATE> [niche] [limit]

import { adapterFor } from '../src/sources/registry/index.js'
import { nicheNameTokens } from '../src/jobs/registry-ingest.js'
import { loadConfig } from '../src/config.js'
import { rootLogger } from '../src/logger.js'

const state = (process.argv[2] ?? '').toUpperCase()
const niche = process.argv[3] ?? 'car wrap'
const limit = Number(process.argv[4] ?? 25)
if (!state) throw new Error('usage: adapter-probe.ts <STATE> [niche] [limit]')

const config = loadConfig({ ...process.env, WORKER_ROLE: 'registry' } as NodeJS.ProcessEnv)
const logger = rootLogger.child({ stage: 'adapter-probe' })
const adapter = adapterFor(state, config, logger)
if (!adapter) throw new Error(`no adapter for ${state}`)

const tokens = nicheNameTokens(niche)
console.log(`adapter=${adapter.name} state=${adapter.state}`)
console.log(`niche="${niche}" tokens=${tokens.join(', ')}`)
console.log(`limit=${limit}\n`)

const started = Date.now()
let seen = 0, withPerson = 0, withZip = 0, withStreet = 0
const roles = new Map<string, number>()
const samples: string[] = []

for await (const e of adapter.ingest({ nameContains: tokens, limit })) {
  seen++
  if (e.officers.length) withPerson++
  if (e.postalCode.replace(/\D/g, '').length >= 5) withZip++
  if (e.street) withStreet++
  for (const o of e.officers) roles.set(o.source_field, (roles.get(o.source_field) ?? 0) + 1)

  if (samples.length < 12) {
    const who = e.officers.map(o => `${o.first} ${o.last} [${o.title}/${o.source_field}]`).join('; ')
    samples.push(
      `  ${e.entityId.padEnd(14)} ${e.name.slice(0, 44).padEnd(44)} ` +
      `${(e.city || '—').slice(0, 16).padEnd(16)} ${(e.postalCode || '—').padEnd(11)} ` +
      `${who || '(nobody)'}`)
  }
}

console.log(samples.join('\n'))
console.log(`\nseen ${seen} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`named   ${withPerson} (${pct(withPerson, seen)})`)
console.log(`has zip ${withZip} (${pct(withZip, seen)})`)
console.log(`has street ${withStreet} (${pct(withStreet, seen)})`)
console.log('officer source fields: ' +
  [...roles.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '(none)')

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : '—'
}
