import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Play } from 'lucide-react'
import { useCampaignDetail } from '../hooks/useCampaignDetail'
import { useAlerts } from '../hooks/useAlerts'
import { useCampaignRunner } from '../hooks/useCampaignRunner'
import { StepProgress } from '../components/campaign/StepProgress'
import { CampaignStats } from '../components/campaign/CampaignStats'
import { LogsPanel } from '../components/campaign/LogsPanel'
import { LeadsTable } from '../components/campaign/LeadsTable'
import { ExportButton } from '../components/campaign/ExportButton'
import { AlertBanner } from '../components/campaign/AlertBanner'
import { StatusBadge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { campaign, leads, logs, loading, tiers, preflight } = useCampaignDetail(id!)
  const { alerts, acknowledge } = useAlerts(id)
  const { run, resume } = useCampaignRunner()
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)

  async function handleResume(campaignId: string) {
    setResuming(true)
    setResumeError(null)
    try {
      await resume(campaignId)
    } catch (err) {
      setResumeError((err as Error).message)
    } finally {
      setResuming(false)
    }
  }

  // Kick off the server-side orchestrator once when a fresh campaign is created
  useEffect(() => {
    if (!campaign) return
    if (campaign.status === 'pending' && campaign.current_step === 0) {
      run(campaign.id)
    }
  }, [campaign?.id, campaign?.status])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" className="text-brand-500" />
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-gray-400">Campaign not found.</p>
        <Button variant="ghost" onClick={() => navigate('/')}>Back to dashboard</Button>
      </div>
    )
  }

  const isStuck = campaign.status === 'running' &&
    Date.now() - new Date(campaign.updated_at).getTime() > 5 * 60 * 1000

  return (
    <div className="p-8">
      {/* Breadcrumb */}
      <button
        onClick={() => navigate('/')}
        className="mb-6 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        <ArrowLeft size={15} /> Back to dashboard
      </button>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold capitalize text-gray-100">{campaign.niche}</h1>
            <StatusBadge status={isStuck ? 'paused' : campaign.status} />
          </div>
          <p className="mt-0.5 text-sm text-gray-500">
            {campaign.location} &middot; {campaign.target_count} leads targeted
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Resume button for stuck/paused campaigns */}
          {(campaign.status === 'paused' || isStuck) && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="secondary"
                disabled={resuming}
                onClick={() => handleResume(campaign.id)}
              >
                <Play size={14} /> {resuming ? 'Resuming…' : 'Resume Pipeline'}
              </Button>
              {resumeError && (
                <span className="text-xs text-red-400">{resumeError}</span>
              )}
            </div>
          )}
          {campaign.status === 'completed' && (
            <ExportButton campaignId={campaign.id} />
          )}
        </div>
      </div>

      {/* Alerts — above the funnel, because a broken verifier invalidates
          everything below it rather than showing up as a failure. */}
      {alerts.length > 0 && (
        <div className="mb-6">
          <AlertBanner alerts={alerts} onAcknowledge={acknowledge} />
        </div>
      )}

      {/* Step progress */}
      <div className="mb-8 overflow-x-auto">
        <StepProgress campaign={campaign} />
      </div>

      {/* Stats */}
      <div className="mb-6">
        <CampaignStats campaign={campaign} tiers={tiers} preflight={preflight} />
      </div>

      {/* Logs */}
      <div className="mb-6">
        <LogsPanel logs={logs} />
      </div>

      {/* Leads table */}
      <LeadsTable leads={leads} />
    </div>
  )
}
