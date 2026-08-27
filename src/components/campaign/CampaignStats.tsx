import { UserCheck, Globe, Filter, AlertTriangle, Gauge, Users } from 'lucide-react'
import type { Campaign, PreflightRun, Tier } from '../../lib/types'
import { TIER_DESCRIPTION } from '../../lib/types'
import type { TierCounts } from '../../lib/tiers'
import { censusRate } from '../../lib/tiers'
export type { TierCounts }

/**
 * The headline is sendable leads, not scraped rows.
 *
 * "Leads scraped" used to be the only number on screen, which is how a 468-row
 * export read as a success when a handful of rows could actually be emailed to
 * a named person. v2 splits the verdict four ways, because "not Tier A" covers
 * two different things — a row that is sendable with a caveat, and a row that
 * names someone we cannot reach.
 */

function Stat({
  icon, value, sub, label, tone = 'default', title,
}: {
  icon: React.ReactNode
  value: string | number
  sub?: string
  label: string
  tone?: 'default' | 'primary' | 'warn'
  title?: string
}) {
  const valueTone =
    tone === 'primary' ? 'text-brand-300'
    : tone === 'warn'  ? 'text-amber-300'
    : 'text-gray-100'

  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3"
      title={title}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-800">
        {icon}
      </div>
      <div>
        <div className={`text-xl font-semibold ${valueTone}`}>
          {typeof value === 'number' ? value.toLocaleString() : value}
          {sub && <span className="text-sm font-normal text-gray-600"> {sub}</span>}
        </div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  )
}

/** One segment of the tier bar. */
function TierBar({ counts, total }: { counts: TierCounts; total: number }) {
  if (total === 0) return null
  const segments: Array<{ tier: Tier; n: number; className: string; label: string }> = [
    { tier: 'A', n: counts.A, className: 'bg-brand-400', label: 'Tier A' },
    { tier: 'B', n: counts.B, className: 'bg-brand-700', label: 'Tier B' },
    { tier: 'C', n: counts.C, className: 'bg-amber-700', label: 'Tier C' },
    { tier: 'rejected', n: counts.rejected, className: 'bg-gray-800', label: 'Rejected' },
  ]

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-900">
        {segments.map(s => s.n > 0 && (
          <div
            key={s.tier}
            className={s.className}
            style={{ width: `${(s.n / total) * 100}%` }}
            title={`${s.label}: ${s.n} — ${TIER_DESCRIPTION[s.tier]}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map(s => (
          <span key={s.tier} className="flex items-center gap-1.5 text-gray-500">
            <span className={`inline-block h-2 w-2 rounded-full ${s.className}`} />
            {s.label} <span className="font-medium text-gray-300">{s.n.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Residential proxy spend against the per-campaign budget. */
function ResidentialBudget({ campaign }: { campaign: Campaign }) {
  const used = campaign.residential_used_bytes ?? 0
  const budget = campaign.residential_budget_bytes ?? 0
  if (!used && !budget) return null

  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
  const hot = pct >= 80

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-gray-500">
          <Gauge size={13} /> Residential proxy
        </span>
        <span className={hot ? 'text-amber-300' : 'text-gray-400'}>
          {gb(used)}{budget > 0 && ` / ${gb(budget)}`}
        </span>
      </div>
      {budget > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
          <div
            className={`h-full ${hot ? 'bg-amber-500' : 'bg-brand-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
        Discovery is the expensive stage; site crawling goes datacenter-first and is
        mostly unbilled. SERP's share is not yet metered.
      </p>
    </div>
  )
}

/**
 * Why this campaign is low-yield, in the niche's own numbers.
 *
 * `completed_low_yield` is a terminal **success**: the run worked and the niche
 * did not. Saying only "low yield" invites the reader to assume a bug, so the
 * census is quoted next to the outcome — that is the whole point of running one
 * before the campaign.
 */
function LowYieldExplanation({
  preflight, sendable, scraped,
}: {
  preflight: PreflightRun | null
  sendable: number
  scraped: number
}) {
  const pct = scraped > 0 ? Math.round((sendable / scraped) * 100) : 0

  return (
    <div className="space-y-3 rounded-xl border border-amber-800 bg-amber-950/50 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="text-sm text-amber-200">
          <span className="font-medium">
            Low yield — the run worked, the niche did not.
          </span>{' '}
          {pct}% of the {scraped.toLocaleString()} businesses discovered produced a
          sendable contact, against the 25% threshold. This is a finished campaign,
          not a failed one — but do not upload the list expecting volume.
        </div>
      </div>

      {preflight && preflight.status === 'complete' ? (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
          <div className="mb-1 font-medium text-amber-200">
            The census said so before the run
          </div>
          <p>
            A {preflight.sample_size}-business census of{' '}
            <span className="font-medium">{preflight.niche}</span> found{' '}
            <span className="font-medium">
              {censusRate(preflight).toFixed(1)}%
            </span>{' '}
            of these businesses publish a personal address on their own domain
            ({preflight.businesses_with_personal} of {preflight.businesses_found}). That
            predicted{' '}
            <span className="font-medium">
              {preflight.predicted_tier_a_low}–{preflight.predicted_tier_a_high}% Tier A
            </span>{' '}
            ({preflight.predicted_band}). You got {pct}% sendable.
          </p>
          <p className="mt-1.5 text-amber-300/70">
            A business that does not publish a personal address cannot be emailed at
            one. That is a property of the niche, and no amount of crawling changes it.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
          <span className="font-medium">No census was run for this niche.</span>{' '}
          A 25-business preflight costs about a dollar and predicts this outcome before
          the budget is spent. Run one from the campaign builder next time.
        </div>
      )}

      <p className="text-xs text-amber-300/70">
        Open the rejected export to see the reason on every row, then narrow the niche
        or the location and re-run.
      </p>
    </div>
  )
}

export function CampaignStats({
  campaign, tiers, preflight = null,
}: {
  campaign: Campaign
  /** Live counts from the leads table. Null while they load. */
  tiers: TierCounts | null
  preflight?: PreflightRun | null
}) {
  const scraped = campaign.step1_done
  const counts = tiers ?? { A: 0, B: 0, C: 0, rejected: 0 }
  const total = counts.A + counts.B + counts.C + counts.rejected
  const sendable = counts.A + counts.B
  const lowYield = campaign.status === 'completed_low_yield'
  const pct = scraped > 0 ? Math.round((sendable / scraped) * 100) : 0
  const spend = campaign.spend_estimate_usd ?? 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Stat
          icon={<UserCheck size={16} className={lowYield ? 'text-amber-400' : 'text-brand-400'} />}
          value={sendable}
          sub={scraped > 0 ? `· ${pct}%` : undefined}
          label="Sendable (Tier A + B)"
          tone={lowYield ? 'warn' : 'primary'}
          title={`${TIER_DESCRIPTION.A}\n\n${TIER_DESCRIPTION.B}`}
        />
        <Stat
          icon={<Users size={16} className="text-gray-400" />}
          value={counts.C}
          label="Named, not reachable"
          title={TIER_DESCRIPTION.C}
        />
        <Stat
          icon={<Globe size={16} className="text-gray-400" />}
          value={scraped}
          sub={`/ ${campaign.target_count}`}
          label="Discovered"
        />
        <Stat
          icon={<Filter size={16} className="text-gray-400" />}
          value={counts.rejected}
          label="Rejected"
          title={TIER_DESCRIPTION.rejected}
        />
        {spend > 0 && (
          <Stat
            icon={<Gauge size={16} className="text-gray-400" />}
            value={`$${spend.toFixed(2)}`}
            sub={scraped > 0 ? `· ${(spend / scraped * 100).toFixed(2)}¢/lead` : undefined}
            label="Est. spend"
          />
        )}
      </div>

      {total > 0 && <TierBar counts={counts} total={total} />}

      <ResidentialBudget campaign={campaign} />

      {lowYield && (
        <LowYieldExplanation
          preflight={preflight}
          sendable={sendable}
          scraped={scraped}
        />
      )}
    </div>
  )
}
