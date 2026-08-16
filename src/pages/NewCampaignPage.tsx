import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Info } from 'lucide-react'
import { supabase, FUNCTIONS_URL } from '../lib/supabase'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

const LOCATION_HINTS = [
  'Texas', 'Florida', 'California', 'New York', 'Illinois',
  'Georgia', 'Ohio', 'Pennsylvania', 'Michigan', 'North Carolina',
  'New York City', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
]

export function NewCampaignPage() {
  const navigate = useNavigate()
  const [niche, setNiche] = useState('')
  const [location, setLocation] = useState('')
  const [count, setCount] = useState(50)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!niche.trim() || !location.trim()) return
    setError('')
    setLoading(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('Not authenticated')

      // Create campaign
      const createRes = await fetch(`${FUNCTIONS_URL}/campaigns-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ niche: niche.trim(), location: location.trim(), count }),
      })
      if (!createRes.ok) {
        const e = await createRes.json().catch(() => ({}))
        throw new Error((e as { error?: string }).error ?? 'Failed to create campaign')
      }
      const { campaign_id } = await createRes.json() as { campaign_id: string }

      // Navigate to detail page — the runner hook will kick off step 1 automatically
      navigate(`/campaign/${campaign_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div className="p-8">
      <button
        onClick={() => navigate('/')}
        className="mb-6 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        <ArrowLeft size={15} /> Back to dashboard
      </button>

      <div className="max-w-lg">
        <h1 className="mb-1 text-2xl font-semibold text-gray-100">New Campaign</h1>
        <p className="mb-8 text-sm text-gray-500">Configure your lead generation campaign.</p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Input
            label="Niche / Industry"
            value={niche}
            onChange={e => setNiche(e.target.value)}
            placeholder="e.g. plumbers, dentists, roofers"
            hint="The type of business you want to find."
            required
            autoFocus
          />

          <div>
            <Input
              label="Location"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Texas, New York, Chicago, Florida"
              hint="Enter a state to search every major city within it, or a specific city/metro area."
              required
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {LOCATION_HINTS.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLocation(m)}
                  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-400 hover:border-gray-600 hover:text-gray-200 transition-colors"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-300">Lead count</label>
              <input
                type="number"
                min={10}
                max={10000}
                step={10}
                value={count}
                onChange={e => {
                  const v = Math.max(10, Math.min(10000, Number(e.target.value) || 10))
                  setCount(v)
                }}
                className="w-24 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-right text-sm font-semibold text-brand-400 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <input
              type="range"
              min={10}
              max={500}
              step={10}
              value={Math.min(count, 500)}
              onChange={e => setCount(Number(e.target.value))}
              className="w-full accent-brand-500"
            />
            <div className="mt-1 flex justify-between text-xs text-gray-600">
              <span>10</span>
              <span>500+ — type above for state-level scraping (1000–5000 recommended)</span>
            </div>
          </div>

          <div className="flex gap-2.5 rounded-lg border border-blue-900 bg-blue-950/40 p-3 text-xs text-blue-400">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              Entering a state (e.g. "Texas") auto-expands to 40–55 cities for maximum lead coverage. Downloads run in the background — safe to close this tab.
              {count > 500 && ' For state-level scraping, set your lead count high (1000+) to get results from every city.'}
            </span>
          </div>

          {error && (
            <p className="rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-400">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={() => navigate('/')}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} disabled={!niche.trim() || !location.trim()}>
              Start Campaign
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
