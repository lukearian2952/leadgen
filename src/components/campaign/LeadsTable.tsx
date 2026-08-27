import { useState } from 'react'
import { ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Lead, Tier } from '../../lib/types'
import { TIER_DESCRIPTION, TIER_LABEL } from '../../lib/types'
import { tierOf, isSendable } from '../../lib/tiers'
import { Button } from '../ui/Button'

const PAGE_SIZE = 25

const TIER_STYLE: Record<Tier, string> = {
  A: 'border-brand-500/40 bg-brand-500/10 text-brand-300',
  B: 'border-brand-700/50 bg-brand-800/20 text-brand-400',
  C: 'border-amber-700/40 bg-amber-900/20 text-amber-300',
  rejected: 'border-gray-700/60 bg-gray-800/40 text-gray-500',
}

function TierBadge({ lead }: { lead: Lead }) {
  const tier = tierOf(lead)
  // Tier B's caveat and a rejection's reason are the useful detail; both live
  // in reject_reason, which is set on B rows too.
  const detail = lead.reject_reason ? `\n\nReason: ${lead.reject_reason}` : ''
  return (
    <span
      className={`inline-flex shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TIER_STYLE[tier]}`}
      title={`${TIER_LABEL[tier]} — ${TIER_DESCRIPTION[tier]}${detail}`}
    >
      {tier === 'rejected' ? '—' : tier}
    </span>
  )
}

export function LeadsTable({ leads }: { leads: Lead[] }) {
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [sendableOnly, setSendableOnly] = useState(false)

  const sendableCount = leads.filter(isSendable).length

  const filtered = leads.filter(l => {
    if (sendableOnly && !isSendable(l)) return false
    if (!search) return true
    const q = search.toLowerCase()
    return l.business_name.toLowerCase().includes(q) ||
           l.city.toLowerCase().includes(q) ||
           (l.owner_name ?? '').toLowerCase().includes(q) ||
           (l.owner_email ?? '').toLowerCase().includes(q)
  })

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const pageLeads  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-400">
            {filtered.length} lead{filtered.length !== 1 ? 's' : ''}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300">
            <input
              type="checkbox"
              checked={sendableOnly}
              onChange={e => { setSendableOnly(e.target.checked); setPage(0) }}
              className="accent-brand-500"
            />
            Sendable only ({sendableCount})
          </label>
        </div>
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-brand-500 focus:outline-none w-48"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-600">
              <th className="px-4 py-3 font-medium">Business</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Owner</th>
              <th className="px-4 py-3 font-medium">Owner email</th>
              <th className="px-4 py-3 font-medium">City</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Website</th>
            </tr>
          </thead>
          <tbody>
            {pageLeads.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-600">
                  {leads.length === 0 ? 'No leads yet — scraping in progress.' : 'No results for your search.'}
                </td>
              </tr>
            ) : (
              pageLeads.map(lead => (
                <tr key={lead.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 font-medium text-gray-200 max-w-48 truncate">
                    <span className="truncate">{lead.business_name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <TierBadge lead={lead} />
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {lead.owner_name ? (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{lead.owner_name}</span>
                        {/* Where the name came from, and whether anything agreed
                            with it. A clinical lead only gets promoted when a
                            second source does. */}
                        {lead.corroboration && lead.corroboration.length > 1 && (
                          <span
                            className="shrink-0 rounded bg-gray-800 px-1 text-[10px] text-gray-400"
                            title={`Corroborated by: ${lead.corroboration.join(', ')}`}
                          >
                            ×{lead.corroboration.length}
                          </span>
                        )}
                      </span>
                    ) : (
                      /* The reject reason is the useful thing to show when there is no owner */
                      <span className="text-gray-700" title={lead.reject_reason}>
                        {lead.reject_reason || '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 max-w-56 truncate">
                    {lead.owner_email || <span className="text-gray-700">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{lead.city}</td>
                  <td className="px-4 py-3 text-gray-400">{lead.phone || '—'}</td>
                  <td className="px-4 py-3">
                    {lead.website ? (
                      <a
                        href={lead.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1 text-brand-400 hover:text-brand-300"
                      >
                        <ExternalLink size={12} />
                        <span className="max-w-32 truncate">{lead.website.replace(/^https?:\/\/(www\.)?/, '')}</span>
                      </a>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-800 px-4 py-3">
          <span className="text-xs text-gray-600">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft size={14} />
            </Button>
            <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
