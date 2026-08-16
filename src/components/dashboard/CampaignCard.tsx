import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Globe, MapPin, Clock, Play, Trash2, X, UserCheck } from 'lucide-react'
import { isFinished, type Campaign } from '../../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ProgressBar } from '../ui/ProgressBar'

function isStuck(campaign: Campaign): boolean {
  if (campaign.status !== 'running') return false
  const updatedAt = new Date(campaign.updated_at).getTime()
  return Date.now() - updatedAt > 5 * 60 * 1000
}

interface Props {
  campaign: Campaign
  onDelete: (id: string) => Promise<void>
}

export function CampaignCard({ campaign, onDelete }: Props) {
  const navigate = useNavigate()
  const stuck = isStuck(campaign)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirming) { setConfirming(true); return }
    setDeleting(true)
    await onDelete(campaign.id)
  }

  const progress = isFinished(campaign.status)
    ? 100
    : campaign.target_count > 0
      ? Math.round((campaign.step1_done / campaign.target_count) * 100)
      : 0

  return (
    <div
      className="group cursor-pointer rounded-xl border border-gray-800 bg-gray-900 p-5 transition-colors hover:border-gray-700"
      onClick={() => navigate(`/campaign/${campaign.id}`)}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-gray-100 capitalize">{campaign.niche}</h3>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
            <MapPin size={11} />
            {campaign.location}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={stuck ? 'paused' : campaign.status} />
          {confirming ? (
            <>
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                onClick={handleDelete}
              >
                <Trash2 size={12} /> Delete
              </Button>
              <button
                className="text-gray-500 hover:text-gray-300 transition-colors"
                onClick={e => { e.stopPropagation(); setConfirming(false) }}
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <button
              className="text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
              onClick={handleDelete}
              title="Delete campaign"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar (only when running) */}
      {campaign.status === 'running' && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span>Scraping businesses...</span>
            <span>{campaign.step1_done} / {campaign.target_count}</span>
          </div>
          <ProgressBar value={progress} />
        </div>
      )}

      {/* Stats — owner-ready leads first; scraped is the supporting number */}
      <div className="flex items-center gap-4 text-sm text-gray-300">
        <div className="flex items-center gap-1.5" title="Leads with a named owner at a verified-deliverable mailbox">
          <UserCheck size={13} className={campaign.status === 'completed_low_yield' ? 'text-amber-400' : 'text-brand-400'} />
          <span className="font-semibold">{campaign.stat_owner_ready ?? 0}</span>
          <span className="text-gray-600">owner-ready</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-500">
          <Globe size={13} className="text-gray-600" />
          <span>{campaign.step1_done}</span>
          <span className="text-gray-600">scraped</span>
        </div>
      </div>

      {/* Stuck / resume */}
      {stuck && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-yellow-800 bg-yellow-950/50 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-yellow-400">
            <Clock size={12} />
            Scraping interrupted
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={e => { e.stopPropagation(); navigate(`/campaign/${campaign.id}`) }}
          >
            <Play size={12} /> Resume
          </Button>
        </div>
      )}

      <div className="mt-3 text-xs text-gray-600">
        {new Date(campaign.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
    </div>
  )
}
