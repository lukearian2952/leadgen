// `EdgeRuntime` is injected by the Supabase Edge Runtime and does not exist in
// Deno's own type definitions, so referencing it directly fails `deno check`.
// Reading it off globalThis keeps the fire-and-forget chaining pattern working
// at runtime while staying type-checkable, and no-ops under plain `deno run`.

interface EdgeRuntimeLike {
  waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Keep a fire-and-forget request alive past the response.
 *
 * Every step in this pipeline chains to the next one this way; without it the
 * runtime can tear the isolate down mid-request and the chain silently stops.
 */
export function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as Record<string, unknown>).EdgeRuntime as
    EdgeRuntimeLike | undefined
  runtime?.waitUntil?.(promise)
}
