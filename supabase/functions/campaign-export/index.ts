import { serviceClient, type Db } from '../_shared/db.ts'
import { corsResponse, jsonResponse, errorResponse } from '../_shared/cors.ts'

// Two files, always. The main CSV is what goes into a sender and contains only
// gate-passing rows; the rejected CSV carries everything else with the reason
// it was held back, so a thin result is diagnosable instead of mysterious.
//
// Rows are split on `gate_passed`, which finalizeCampaign writes. The export
// deliberately does not re-run the gate itself — one writer, one verdict.

const MAIN_COLUMNS = [
  'Business Name', 'Owner First Name', 'Owner Last Name', 'Owner Title',
  'Owner Email', 'Phone', 'Website', 'City', 'State', 'General Email',
]

const REJECTED_COLUMNS = [...MAIN_COLUMNS, 'Reject Reason']

type LeadRow = Record<string, string | null>

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function rowValues(lead: LeadRow): string[] {
  return [
    lead.business_name    ?? '',
    lead.owner_first_name ?? '',
    lead.owner_last_name  ?? '',
    lead.title            ?? '',
    lead.owner_email      ?? '',
    lead.phone            ?? '',
    lead.website          ?? '',
    lead.city             ?? '',
    lead.state            ?? '',
    lead.email            ?? '',
  ]
}

function buildCsv(leads: LeadRow[], withReason: boolean): string {
  const header = withReason ? REJECTED_COLUMNS : MAIN_COLUMNS
  const rows: string[] = [header.map(escapeCsv).join(',')]
  for (const lead of leads) {
    const values = rowValues(lead)
    if (withReason) values.push(lead.reject_reason ?? '')
    rows.push(values.map(escapeCsv).join(','))
  }
  return rows.join('\r\n')
}

async function upload(
  supabase: Db,
  path: string, csv: string, filename: string,
): Promise<string | null> {
  const { error } = await supabase.storage
    .from('exports')
    .upload(path, new TextEncoder().encode(csv), { contentType: 'text/csv', upsert: true })
  if (error) return null

  const { data } = await supabase.storage
    .from('exports')
    .createSignedUrl(path, 3600, { download: filename })
  return data?.signedUrl ?? null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse()

  const url = new URL(req.url)
  const campaign_id = url.searchParams.get('campaign_id')
  if (!campaign_id) return errorResponse('campaign_id required')

  const supabase = serviceClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, niche, location, user_id, stat_owner_ready, stat_rejected')
    .eq('id', campaign_id)
    .single()

  if (!campaign) return errorResponse('Campaign not found', 404)

  const { data: leads, error } = await supabase
    .from('leads')
    .select('business_name, owner_first_name, owner_last_name, title, owner_email, phone, website, city, state, email, gate_passed, reject_reason')
    .eq('campaign_id', campaign_id)
    .order('created_at', { ascending: true })

  if (error) return errorResponse(error.message, 500)

  const all = (leads ?? []) as LeadRow[]
  const passed = all.filter(l => l.gate_passed as unknown as boolean)
  const rejected = all.filter(l => !(l.gate_passed as unknown as boolean))

  const slug = `${String(campaign.niche).replace(/\W+/g, '_')}_${String(campaign.location).replace(/\W+/g, '_')}`

  const mainUrl = await upload(
    supabase,
    `${campaign.user_id}/${campaign_id}.csv`,
    buildCsv(passed, false),
    `leads_${slug}.csv`,
  )
  if (!mainUrl) return errorResponse('Failed to upload export', 500)

  const rejectedUrl = await upload(
    supabase,
    `${campaign.user_id}/${campaign_id}-rejected.csv`,
    buildCsv(rejected, true),
    `leads_${slug}_rejected.csv`,
  )

  return jsonResponse({
    url: mainUrl,
    rejected_url: rejectedUrl,
    owner_ready: passed.length,
    rejected: rejected.length,
    total: all.length,
  })
})
