// Gate rule 3: the website domain must actually accept mail.
//
// Deno.resolveDns is not dependable inside the Supabase edge runtime, so this
// goes over DNS-over-HTTPS instead — plain fetch, works anywhere, and lets us
// fall back to a second resolver when the first is flaky.

const DOH_ENDPOINTS = [
  (name: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
  (name: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=MX`,
]

interface DohAnswer { type?: number; data?: string }
interface DohResponse { Status?: number; Answer?: DohAnswer[] }

/**
 * Process-wide memo. Many leads in a campaign share a domain (chains, franchise
 * sites), and a single edge invocation checks a whole batch.
 */
const mxCache = new Map<string, boolean>()

async function queryMx(domain: string): Promise<boolean | null> {
  for (const build of DOH_ENDPOINTS) {
    try {
      const res = await fetch(build(domain), {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) continue
      const json = await res.json() as DohResponse
      // NXDOMAIN (3) is a definitive "no".
      if (json.Status === 3) return false
      if (json.Status !== 0) continue
      const hasMx = (json.Answer ?? []).some(a => a.type === 15 && !!a.data)
      return hasMx
    } catch { /* try the next resolver */ }
  }
  return null   // both resolvers failed — caller decides
}

/**
 * Returns true/false when the lookup succeeded, or null when every resolver
 * failed. Null must not be treated as a rejection: a resolver outage would
 * otherwise wipe out an entire campaign's export.
 */
export async function hasMx(domain: string): Promise<boolean | null> {
  const d = (domain ?? '').toLowerCase().trim()
  if (!d || !d.includes('.')) return false
  if (mxCache.has(d)) return mxCache.get(d)!

  const result = await queryMx(d)
  if (result !== null) mxCache.set(d, result)
  return result
}

/** Resolve MX for many domains with bounded concurrency. */
export async function hasMxBatch(
  domains: string[], concurrency = 8,
): Promise<Map<string, boolean | null>> {
  const unique = [...new Set(domains.filter(Boolean).map(d => d.toLowerCase()))]
  const out = new Map<string, boolean | null>()
  let cursor = 0

  async function worker() {
    while (cursor < unique.length) {
      const domain = unique[cursor++]
      out.set(domain, await hasMx(domain))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, worker),
  )
  return out
}
