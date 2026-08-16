import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // The caller's identity comes from their JWT and nowhere else.
  //
  // This used to fall back to `listUsers({ perPage: 1 })` — "the first user in
  // the system" — whenever the token was missing or unreadable. With a single
  // account that looked like a convenience; with two it silently files one
  // user's campaign under another user's id, and an unauthenticated caller
  // gets a campaign created for whoever happens to be first. No fallback.
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) return errorResponse('Missing bearer token', 401)

  const { data: { user }, error: authError } = await createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
  ).auth.getUser(token)

  if (authError || !user?.id) return errorResponse('Invalid or expired token', 401)
  const userId = user.id

  const body = await req.json().catch(() => ({}))
  const { niche, location, count } = body as { niche?: string; location?: string; count?: number }

  if (!niche?.trim())    return errorResponse('niche is required')
  if (!location?.trim()) return errorResponse('location is required')
  if (!count || count < 1 || count > 10000) return errorResponse('count must be 1–10000')

  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      user_id:      userId,
      niche:        niche.trim(),
      location:     location.trim(),
      target_count: count,
      status:       'pending',
      current_step: 0,
    })
    .select('id')
    .single()

  if (error) return errorResponse(error.message, 500)

  return jsonResponse({ campaign_id: data.id })
})
