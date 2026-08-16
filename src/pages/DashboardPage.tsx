import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useCampaigns } from '../hooks/useCampaigns'
import { CampaignCard } from '../components/dashboard/CampaignCard'
import { EmptyState } from '../components/dashboard/EmptyState'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'

export function DashboardPage() {
  const navigate = useNavigate()
  const { campaigns, loading, deleteCampaign } = useCampaigns()

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Campaigns</h1>
          <p className="mt-0.5 text-sm text-gray-500">Manage your lead generation campaigns</p>
        </div>
        <Button onClick={() => navigate('/new')}>
          <Plus size={16} /> New Campaign
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner size="lg" className="text-brand-500" />
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map(c => <CampaignCard key={c.id} campaign={c} onDelete={deleteCampaign} />)}
        </div>
      )}
    </div>
  )
}
