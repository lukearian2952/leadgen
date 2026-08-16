import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Alert } from '../lib/types'

/**
 * Open operator alerts, live.
 *
 * These exist because a verifier that cannot run is invisible otherwise. A
 * Verifalia 402 took out the entire fallback for a whole run and the only trace
 * was a line in a container log — the run looked like it worked and produced
 * nothing. An alert has to be on screen while the run is still going, not
 * discoverable afterwards.
 *
 * Fleet-wide alerts have no campaign_id and are returned for every campaign,
 * because "the shared verifier is out of credits" is true of all of them.
 */
export function useAlerts(campaignId?: string) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    let query = supabase
      .from('alerts')
      .select('*')
      .is('acknowledged_at', null)
      .order('last_seen_at', { ascending: false })

    if (campaignId) {
      query = query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`)
    }

    const { data } = await query
    setAlerts((data ?? []) as Alert[])
  }, [campaignId])

  useEffect(() => {
    load().then(() => setLoading(false))

    const channel = supabase
      .channel(`alerts-${campaignId ?? 'global'}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'alerts' },
        () => { load() })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [campaignId, load])

  const acknowledge = useCallback(async (id: string) => {
    // Optimistic: the banner should disappear on click, not a round trip later.
    setAlerts(current => current.filter(a => a.id !== id))
    await supabase
      .from('alerts')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', id)
  }, [])

  return { alerts, loading, acknowledge, reload: load }
}
