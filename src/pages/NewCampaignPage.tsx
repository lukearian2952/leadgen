import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Info, Gauge, FlaskConical, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCampaignRunner, DEFAULT_RESIDENTIAL_BUDGET_BYTES } from '../hooks/useCampaignRunner'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import type { PreflightRun } from '../lib/types'
import { censusRate } from '../lib/tiers'

const LOCATION_HINTS = [
  'Texas', 'Florida', 'California', 'New York', 'Illinois',
  'Georgia', 'Ohio', 'Pennsylvania', 'Michigan', 'North Carolina',
  'New York City', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
]

/**
 * Measured cost per business across the completed campaigns: $0.0066 on the
 * 1,000-business national run, $0.0069 on the SaaS run. Rounded up, because a
 * builder that under-promises cost is the wrong way round.
 */
const COST_PER_BUSINESS_USD = 0.008

/**
 * Residential bytes per business, from the 1,000-business national run
 * (1.53 GB / 1,042). A SaaS campaign is roughly 30x cheaper because there is no
 * Chromium driving a map, but budgeting for the expensive case is the safe way
 * to be wrong.
 */
const RESIDENTIAL_BYTES_PER_BUSINESS = 1_500_000

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`
}

/**
 * The niche census, if one has been run.
 *
 * `HANDOFF.md` §11: the benchmark niche contaminated three phases of
 * conclusions, and the fix was one crawl census that predicts Tier A well
 * enough to say so before the budget is spent. This panel is that finding as a
 * product feature — the whole point is that it appears *before* the run.
 */
function CensusPanel({ niche, location }: { niche: string; location: string }) {
  const [preflight, setPreflight] = useState<PreflightRun | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const n = niche.trim(), l = location.trim()
    if (!n || !l) { setPreflight(null); setChecked(false); return }

    let cancelled = false
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('preflight_runs')
        .select('*')
        .eq('niche', n)
        .eq('location', l)
        .order('created_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      setPreflight(data?.length ? (data[0] as PreflightRun) : null)
      setChecked(true)
    }, 400)   // the fields are typed into; do not query on every keystroke

    return () => { cancelled = true; clearTimeout(timer) }
  }, [niche, location])

  if (!checked) return null

  if (!preflight || preflight.status !== 'complete') {
    return (
      <div className="flex gap-2.5 rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-500">
        <FlaskConical size={14} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-medium text-gray-400">No census for this niche yet.</span>{' '}
          The share of businesses that publish a personal address on their own domain
          predicts Tier A yield better than anything else we measure — and a niche that
          does not publish one cannot be emailed at one, however well the pipeline runs.
          This campaign will produce the first data point.
        </span>
      </div>
    )
  }

  const rate = censusRate(preflight)
  const poor = preflight.predicted_band === 'poor'

  return (
    <div className={`flex gap-2.5 rounded-lg border p-3 text-xs ${
      poor ? 'border-amber-800 bg-amber-950/40 text-amber-300'
           : 'border-brand-900 bg-brand-950/30 text-brand-300'}`}>
      {poor
        ? <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
      <div className="leading-relaxed">
        <span className="font-medium">
          Census: {rate.toFixed(1)}% publish a personal address on their own domain.
        </span>{' '}
        Predicts <span className="font-medium">
          {preflight.predicted_tier_a_low}–{preflight.predicted_tier_a_high}% Tier A
        </span>{' '}
        ({preflight.predicted_band}), from a {preflight.sample_size}-business sample.
        {poor && (
          <span className="mt-1 block text-amber-400/90">
            Expect most yield as Tier B — named owners at catch-all or published
            addresses — rather than Tier A. Consider a different niche before
            spending the budget.
          </span>
        )}
      </div>
    </div>
  )
}

export function NewCampaignPage() {
  const navigate = useNavigate()
  const { run } = useCampaignRunner()
  const [niche, setNiche] = useState('')
  const [location, setLocation] = useState('')
  const [count, setCount] = useState(50)
  const [budgetGb, setBudgetGb] = useState(DEFAULT_RESIDENTIAL_BUDGET_BYTES / 1e9)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const estimatedCost = count * COST_PER_BUSINESS_USD
  const estimatedBytes = count * RESIDENTIAL_BYTES_PER_BUSINESS
  const budgetBytes = Math.round(budgetGb * 1e9)
  const budgetTight = estimatedBytes > budgetBytes

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!niche.trim() || !location.trim()) return
    setError('')
    setLoading(true)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      // Inserted directly under RLS rather than through the `campaigns-create`
      // Edge Function. That function belongs to v1 and only ever did this
      // insert; routing through it added a deploy target for one statement.
      const { data, error: insertError } = await supabase
        .from('campaigns')
        .insert({
          user_id: user.id,
          niche: niche.trim(),
          location: location.trim(),
          target_count: count,
          status: 'pending',
          current_step: 0,
        })
        .select('id')
        .single()

      if (insertError) throw new Error(insertError.message)

      // Enqueue discovery on the worker fleet. The RPC picks maps: or saas:
      // from the niche and refuses a campaign this user does not own.
      const result = await run(data.id, budgetBytes)
      if (!result.started && result.reason) throw new Error(result.reason)

      navigate(`/campaign/${data.id}`)
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
            placeholder="e.g. plumbers, dentists, practice management software"
            hint="The type of business you want to find. An online or SaaS niche is discovered through search rather than maps."
            required
            autoFocus
          />

          <div>
            <Input
              label="Location"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Texas, New York, Chicago, United States"
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

          <CensusPanel niche={niche} location={location} />

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
              <span>500+ — type above for state-level scraping</span>
            </div>
          </div>

          {/* ── Budget ────────────────────────────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-medium text-gray-300">
              <Gauge size={14} className="text-gray-500" /> Budget
            </div>

            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="text-gray-500">Estimated cost</span>
              <span className="font-medium text-gray-300">
                ${estimatedCost.toFixed(2)}
                <span className="ml-1 font-normal text-gray-600">
                  · {(COST_PER_BUSINESS_USD * 100).toFixed(1)}¢/business
                </span>
              </span>
            </div>

            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs text-gray-500">Residential proxy cap</label>
              <span className="text-xs font-medium text-gray-300">{budgetGb.toFixed(1)} GB</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={budgetGb}
              onChange={e => setBudgetGb(Number(e.target.value))}
              className="w-full accent-brand-500"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
              Discovery stops when the cap is reached, keeping whatever it has found.
              A maps campaign spends about {gb(RESIDENTIAL_BYTES_PER_BUSINESS)} per
              business; an online niche spends roughly 30× less.
            </p>

            {budgetTight && (
              <p className="mt-2 rounded border border-amber-900 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-300">
                {count.toLocaleString()} businesses at maps rates is about{' '}
                {gb(estimatedBytes)} — more than this cap. Discovery will stop early
                and return fewer leads than the target.
              </p>
            )}
          </div>

          <div className="flex gap-2.5 rounded-lg border border-blue-900 bg-blue-950/40 p-3 text-xs text-blue-400">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              Entering a state (e.g. "Texas") auto-expands to its major cities.
              Discovery runs in the background — safe to close this tab.
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
