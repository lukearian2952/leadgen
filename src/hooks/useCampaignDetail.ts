import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Campaign, Lead, CampaignLog } from '../lib/types'

export function useCampaignDetail(campaignId: string) {
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [logs, setLogs] = useState<CampaignLog[]>([])
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

  useEffect(() => {
    Promise.all([loadCampaign(), loadLeads(), loadLogs()]).then(() => setLoading(false))

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
  }, [campaignId, loadCampaign, loadLeads, loadLogs])

  // Polling fallback: if Realtime misses the completion event, poll every 4s while running
  useEffect(() => {
    if (!campaign || campaign.status !== 'running') return
    const interval = setInterval(loadCampaign, 4000)
    return () => clearInterval(interval)
  }, [campaign?.status, loadCampaign])

  return { campaign, leads, logs, loading, refetchLeads: loadLeads }
}
