import { UserCheck, Globe, Filter, AlertTriangle } from 'lucide-react'
import type { Campaign } from '../../lib/types'

/**
 * Owner-ready is the headline. "Leads scraped" used to be the only number on
 * screen, which is how a 468-row export read as a success when only a handful
 * of rows could actually be emailed to a named person.
 */
function Stat({
  icon, value, sub, label, tone = 'default',
}: {
  icon: React.ReactNode
  value: number
  sub?: string
  label: string
  tone?: 'default' | 'primary' | 'warn'
}) {
  const valueTone =
    tone === 'primary' ? 'text-brand-300'
    : tone === 'warn'  ? 'text-amber-300'
    : 'text-gray-100'

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-800">
        {icon}
      </div>
      <div>
        <div className={`text-xl font-semibold ${valueTone}`}>
          {value.toLocaleString()}
          {sub && <span className="text-sm font-normal text-gray-600"> {sub}</span>}
        </div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  )
}

export function CampaignStats({ campaign }: { campaign: Campaign }) {
  const scraped = campaign.step1_done
  const ownerReady = campaign.stat_owner_ready ?? 0
  const rejected = campaign.stat_rejected ?? 0
  const lowYield = campaign.status === 'completed_low_yield'
  const pct = scraped > 0 ? Math.round((ownerReady / scraped) * 100) : 0
  const spend = campaign.spend_estimate_usd ?? 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Stat
          icon={<UserCheck size={16} className={lowYield ? 'text-amber-400' : 'text-brand-400'} />}
          value={ownerReady}
          sub={scraped > 0 ? `· ${pct}%` : undefined}
          label="Owner-ready leads"
          tone={lowYield ? 'warn' : 'primary'}
        />
        <Stat
          icon={<Globe size={16} className="text-gray-400" />}
          value={scraped}
          sub={`/ ${campaign.target_count}`}
          label="Scraped"
        />
        <Stat
          icon={<Filter size={16} className="text-gray-400" />}
          value={rejected}
          label="Rejected"
        />
        {spend > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
            <div>
              <div className="text-xl font-semibold text-gray-100">
                ${spend.toFixed(2)}
              </div>
              <div className="text-xs text-gray-500">Est. spend</div>
            </div>
          </div>
        )}
      </div>

      {lowYield && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-800 bg-amber-950/50 px-4 py-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm text-amber-200">
            <span className="font-medium">Low yield — do not upload this list as-is.</span>{' '}
            Only {pct}% of scraped businesses produced a verified owner contact. Open the
            rejected export to see why, then narrow the niche or location and re-run.
          </div>
        </div>
      )}
    </div>
  )
}
