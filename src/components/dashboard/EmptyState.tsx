import { useNavigate } from 'react-router-dom'
import { Rocket } from 'lucide-react'
import { Button } from '../ui/Button'

export function EmptyState() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800">
        <Rocket size={28} className="text-gray-500" />
      </div>
      <h2 className="mb-1 text-lg font-medium text-gray-200">No campaigns yet</h2>
      <p className="mb-6 text-sm text-gray-500">Create your first campaign to start generating leads.</p>
      <Button onClick={() => navigate('/new')}>Start a campaign</Button>
    </div>
  )
}
