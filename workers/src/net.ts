// One configured path for all non-proxied outbound HTTP.
//
// Two things forced this to exist rather than just calling global `fetch`:
//
// 1. Node's built-in fetch uses Node's *internal* copy of undici. Calling
//    `setGlobalDispatcher` from the npm `undici` package configures a different
//    module instance and has no effect on it. Anything that needs to control
//    egress has to go through undici's own `fetch`, which is what this exports.
//
// 2. Broken IPv6. When a host publishes AAAA records but the machine has no
//    working v6 route, the connection attempt is black-holed rather than
//    refused, and Happy Eyeballs never fires — measured here against
//    api.verifalia.com and api.anthropic.com, where `autoSelectFamily` made no
//    difference and only an explicit `family: 4` connected. The symptom is a
//    bare `fetch failed / ETIMEDOUT` that reads exactly like bad credentials,
//    so it is worth being able to rule out in one environment variable.
//
// VPS providers hand out half-configured IPv6 routinely, so `FORCE_IPV4=true`
// is a supported operational setting, not a hack.

import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici'

const forceIPv4 = (process.env.FORCE_IPV4 ?? '').trim().toLowerCase() === 'true'

const agent = new Agent({
  connect: forceIPv4
    ? { family: 4, timeout: 15_000 }
    : { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, timeout: 15_000 },
  // Per-request ceilings, not targets; callers still pass their own signals.
  headersTimeout: 60_000,
  bodyTimeout: 120_000,
})

/**
 * Direct outbound fetch, no proxy. Use for our own services and for APIs that
 * do not care where the request comes from (Anthropic, Verifalia, Socrata).
 *
 * Anything that must not look like a datacenter — Maps, SERP, crawls, LinkedIn
 * — goes through ProxyPool instead, never this.
 */
export function httpFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: agent })
}

export function networkMode(): string {
  return forceIPv4 ? 'ipv4-only (FORCE_IPV4=true)' : 'auto (happy-eyeballs)'
}
