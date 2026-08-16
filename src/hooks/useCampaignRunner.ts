import { useCallback } from 'react'
import { supabase, FUNCTIONS_URL } from '../lib/supabase'

export function useCampaignRunner() {
  const trigger = useCallback(async (campaignId: string, resume = false) => {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) throw new Error('Not authenticated')

    const res = await fetch(`${FUNCTIONS_URL}/campaign-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ campaign_id: campaignId, resume }),
    })

    // Surface failures instead of swallowing them — a silent 500 here was
    // indistinguishable from "resumed fine, still working".
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `Orchestrator returned ${res.status}`)
    }
    return res.json().catch(() => ({}))
  }, [])

  // Start a new campaign (pending → running via step1)
  const run = useCallback((campaignId: string) => trigger(campaignId), [trigger])

  // Pause by setting status — the running orchestrator will see 'paused' and stop chaining
  const stop = useCallback(async (campaignId: string) => {
    await supabase.from('campaigns').update({ status: 'paused' }).eq('id', campaignId)
  }, [])

  // Resume: let the orchestrator own the status transition. Setting 'running'
  // from here first is what made Resume a no-op — the step functions' claim
  // guards only matched pending/paused, so the write raced them out of the way.
  const resume = useCallback((campaignId: string) => trigger(campaignId, true), [trigger])

  return { run, stop, resume }
}
