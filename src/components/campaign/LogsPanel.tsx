import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import type { CampaignLog } from '../../lib/types'

const levelColors = {
  info:    'text-gray-500',
  success: 'text-green-400',
  warning: 'text-yellow-400',
  error:   'text-red-400',
}

const stepColors: Record<number, string> = {
  1: 'text-blue-500',
  2: 'text-purple-500',
  3: 'text-orange-500',
  5: 'text-teal-500',
}

export function LogsPanel({ logs }: { logs: CampaignLog[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950">
      <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Terminal size={14} className="text-gray-500" />
        <span className="text-sm font-medium text-gray-400">Live Logs</span>
        <span className="ml-auto text-xs text-gray-600">{logs.length} entries</span>
      </div>
      <div className="h-64 overflow-y-auto p-4 font-mono text-xs scrollbar-thin">
        {logs.length === 0 ? (
          <span className="text-gray-700">Waiting for pipeline to start...</span>
        ) : (
          logs.map(log => (
            <div key={log.id} className="flex gap-2 leading-relaxed">
              <span className="shrink-0 text-gray-700">
                {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              {log.step > 0 && (
                <span className={`shrink-0 ${stepColors[log.step] ?? 'text-gray-500'}`}>
                  [S{log.step}]
                </span>
              )}
              <span className={levelColors[log.level]}>{log.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
