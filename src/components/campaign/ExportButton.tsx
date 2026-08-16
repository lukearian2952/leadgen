import { useState } from 'react'
import { Download, FileWarning } from 'lucide-react'
import { supabase, FUNCTIONS_URL } from '../../lib/supabase'
import { Button } from '../ui/Button'

interface ExportResult {
  url: string
  rejected_url: string | null
  owner_ready: number
  rejected: number
  total: number
}

/**
 * Two files: the sendable list, and everything that was held back with the
 * reason. The rejected link is offered rather than auto-opened — the point is
 * that it exists and is one click away when a run looks thin.
 */
export function ExportButton({ campaignId }: { campaignId: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ExportResult | null>(null)

  async function handleExport() {
    setLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('Not authenticated')

      const res = await fetch(`${FUNCTIONS_URL}/campaign-export?campaign_id=${campaignId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Export failed')
      }

      const data = await res.json() as ExportResult
      setResult(data)
      window.open(data.url, '_blank')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handleExport} loading={loading} variant="secondary">
        <Download size={14} /> Export CSV
      </Button>

      {result && (
        <div className="flex flex-col items-end gap-1 text-xs">
          <span className="text-gray-500">
            {result.owner_ready.toLocaleString()} owner-ready
            {result.rejected > 0 && ` · ${result.rejected.toLocaleString()} rejected`}
          </span>
          {result.rejected_url && result.rejected > 0 && (
            <a
              href={result.rejected_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-amber-400 hover:text-amber-300"
            >
              <FileWarning size={12} />
              Download rejected list (with reasons)
            </a>
          )}
        </div>
      )}

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  )
}
