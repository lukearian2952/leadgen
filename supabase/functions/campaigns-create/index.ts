import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Try to get user from JWT; fall back to the first (only) user in the system
  const authHeader = req.headers.get('Authorization')
  let userId: string | undefined
  if (authHeader) {
    const { data: { user } } = await createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
    ).auth.getUser(authHeader.replace('Bearer ', ''))
    userId = user?.id
  }
  if (!userId) {
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1 })
    userId = users?.[0]?.id
  }
  if (!userId) return errorResponse('No user found', 500)

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
