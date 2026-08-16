import type { CampaignStatus } from '../../lib/types'

const statusConfig: Record<CampaignStatus, { label: string; classes: string }> = {
  pending:   { label: 'Pending',   classes: 'bg-gray-800 text-gray-400 border-gray-700'     },
  running:   { label: 'Running',   classes: 'bg-blue-950 text-blue-300 border-blue-800'     },
  paused:    { label: 'Paused',    classes: 'bg-yellow-950 text-yellow-300 border-yellow-800' },
  completed: { label: 'Completed', classes: 'bg-green-950 text-green-300 border-green-800'  },
  failed:    { label: 'Failed',    classes: 'bg-red-950 text-red-300 border-red-800'        },
  // Amber, not green: the run succeeded but the list is not safe to send.
  completed_low_yield: {
    label: 'Low yield', classes: 'bg-amber-950 text-amber-300 border-amber-800',
  },
}

export function StatusBadge({ status }: { status: CampaignStatus }) {
  const cfg = statusConfig[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cfg.classes}`}>
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
      )}
      {cfg.label}
    </span>
  )
}

const levelConfig = {
  info:    'text-gray-400',
  success: 'text-green-400',
  warning: 'text-yellow-400',
  error:   'text-red-400',
}

export function LogLevel({ level }: { level: keyof typeof levelConfig }) {
  return <span className={`font-medium ${levelConfig[level]}`}>{level.toUpperCase()}</span>
}
