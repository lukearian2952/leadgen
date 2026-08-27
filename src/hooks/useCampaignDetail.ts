import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Campaign, Lead, CampaignLog, PreflightRun } from '../lib/types'
import { countTiers } from '../lib/tiers'

export function useCampaignDetail(campaignId: string) {
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [logs, setLogs] = useState<CampaignLog[]>([])
  const [preflight, setPreflight] = useState<PreflightRun | null>(null)
  const [loading, setLoading] = useState(true)

  const loadCampaign = useCallback(async () => {
    const { data } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()
    if (data) setCampaign(data as Campaign)
  }, [campaignId])

  const loadLeads = useCallback(async () => {
    const { data } = await supabase
      .from('leads')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true })
    if (data) setLeads(data as Lead[])
  }, [campaignId])

  const loadLogs = useCallback(async () => {
    const { data } = await supabase
      .from('campaign_logs')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true })
      .limit(500)
    if (data) setLogs(data as CampaignLog[])
  }, [campaignId])

  /**
   * The census for this campaign's niche, if one was ever run.
   *
   * Matched on niche + location rather than by a foreign key, because a census
   * is a property of the *niche* and is deliberately reusable across campaigns —
   * running it again for the same niche would spend the budget to re-learn
   * something already known.
   */
  const loadPreflight = useCallback(async () => {
    const { data: campaignRow } = await supabase
      .from('campaigns').select('niche, location').eq('id', campaignId).single()
    if (!campaignRow) return

    const { data } = await supabase
      .from('preflight_runs')
      .select('*')
      .eq('niche', campaignRow.niche)
      .eq('location', campaignRow.location)
      .order('created_at', { ascending: false })
      .limit(1)
    if (data?.length) setPreflight(data[0] as PreflightRun)
  }, [campaignId])

  useEffect(() => {
    Promise.all([loadCampaign(), loadLeads(), loadLogs(), loadPreflight()])
      .then(() => setLoading(false))

    // Realtime: campaign row updates
    const campaignChannel = supabase
      .channel(`campaign-${campaignId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'campaigns',
        filter: `id=eq.${campaignId}`,
      }, payload => {
        setCampaign(payload.new as Campaign)
        loadLeads()
      })
      .subscribe()

    // Realtime: new log entries — also re-fetch campaign in case Realtime for campaigns lags
    const logsChannel = supabase
      .channel(`logs-${campaignId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'campaign_logs',
        filter: `campaign_id=eq.${campaignId}`,
      }, payload => {
        setLogs(prev => [...prev, payload.new as CampaignLog])
        loadCampaign()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(campaignChannel)
      supabase.removeChannel(logsChannel)
    }
  }, [campaignId, loadCampaign, loadLeads, loadLogs, loadPreflight])

  // Polling fallback: if Realtime misses the completion event, poll every 4s while running
  useEffect(() => {
    if (!campaign || campaign.status !== 'running') return
    const interval = setInterval(loadCampaign, 4000)
    return () => clearInterval(interval)
  }, [campaign?.status, loadCampaign])

  return {
    campaign, leads, logs, preflight, loading,
    tiers: leads.length ? countTiers(leads) : null,
    refetchLeads: loadLeads,
  }
}
