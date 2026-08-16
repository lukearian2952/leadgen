import { Check, Loader2 } from 'lucide-react'
import { isFinished, type Campaign } from '../../lib/types'

export function StepProgress({ campaign }: { campaign: Campaign }) {
  const done   = isFinished(campaign.status)
  const active = campaign.status === 'running'

  return (
    <div className="flex items-center gap-3">
      <div className={`
        flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-medium transition-all
        ${done   ? 'border-brand-600 bg-brand-600 text-white' : ''}
        ${active ? 'border-brand-500 bg-gray-950 text-brand-400 animate-pulse' : ''}
        ${!done && !active ? 'border-gray-700 bg-gray-900 text-gray-600' : ''}
      `}>
        {done   ? <Check size={14} /> :
         active ? <Loader2 size={14} className="animate-spin" /> :
         '1'}
      </div>
      <span className={`text-xs ${done || active ? 'text-gray-300' : 'text-gray-600'}`}>
        Scraping
      </span>
    </div>
  )
}
