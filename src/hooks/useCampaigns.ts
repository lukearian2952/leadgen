import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Campaign } from '../lib/types'

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setCampaigns(data as Campaign[])
    setLoading(false)
  }

  useEffect(() => {
    load()

    // Realtime: update campaign rows live
    const channel = supabase
      .channel('campaigns-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => {
        load()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  async function deleteCampaign(id: string) {
    await supabase.from('campaigns').delete().eq('id', id)
  }

  return { campaigns, loading, reload: load, deleteCampaign }
}
