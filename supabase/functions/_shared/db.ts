// One place to build the service-role client, and one type name for it.
//
// Helpers that take a client used to be typed `ReturnType<typeof createClient>`,
// which resolves to the *default* generic instantiation — not the type you get
// from calling `createClient(url, key)`. Passing a real client to such a helper
// is a type error in every file that does it, which is why `deno check` has
// never passed here. Deriving the alias from the factory keeps the two in step.

import { createClient } from 'npm:@supabase/supabase-js@2'

/** Service-role client: bypasses RLS, for Edge Function use only. */
export function serviceClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey)
}

export type Db = ReturnType<typeof serviceClient>

/** Build one straight from the ambient Edge Function environment. */
export function serviceClientFromEnv(): Db {
  return serviceClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}
