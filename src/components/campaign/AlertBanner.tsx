import { AlertTriangle, XCircle, Info, X } from 'lucide-react'
import type { Alert } from '../../lib/types'

/**
 * Operator alerts, shown above the funnel.
 *
 * Deliberately not dismissible-by-default and deliberately loud. The condition
 * this was built for — the paid verifier out of credits — does not stop a run
 * or make it error; it makes every result quietly unverifiable. If that is not
 * visible at a glance it gets discovered after the export.
 */

const STYLES = {
  error: {
    wrap: 'border-red-500/40 bg-red-500/10',
    icon: 'text-red-400',
    title: 'text-red-200',
    body: 'text-red-300/80',
    Icon: XCircle,
  },
  warning: {
    wrap: 'border-amber-500/40 bg-amber-500/10',
    icon: 'text-amber-400',
    title: 'text-amber-200',
    body: 'text-amber-300/80',
    Icon: AlertTriangle,
  },
  info: {
    wrap: 'border-sky-500/40 bg-sky-500/10',
    icon: 'text-sky-400',
    title: 'text-sky-200',
    body: 'text-sky-300/80',
    Icon: Info,
  },
} as const

/** Human titles per alert kind. Falls back to the raw kind for anything new. */
const TITLES: Record<string, string> = {
  verifalia_payment_required: 'Verifalia is out of credits',
  verifalia_unauthorized: 'Verifalia rejected our credentials',
  verifier_all_ips_cooling: 'All verification IPs are cooling',
  no_verifier_available: 'No verifier is available',
}

interface Props {
  alerts: Alert[]
  onAcknowledge?: (id: string) => void
}

export function AlertBanner({ alerts, onAcknowledge }: Props) {
  if (!alerts.length) return null

  return (
    <div className="space-y-3">
      {alerts.map(alert => {
        const style = STYLES[alert.severity] ?? STYLES.error
        const { Icon } = style

        return (
          <div
            key={alert.id}
            role="alert"
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${style.wrap}`}
          >
            <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${style.icon}`} />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`text-sm font-semibold ${style.title}`}>
                  {TITLES[alert.kind] ?? alert.kind}
                </span>
                {alert.occurrences > 1 && (
                  <span className={`rounded-full border border-current/30 px-2 py-0.5 text-[11px] ${style.body}`}>
                    {alert.occurrences}×
                  </span>
                )}
              </div>

              <p className={`mt-1 text-sm leading-relaxed ${style.body}`}>
                {alert.message}
              </p>

              <p className={`mt-1 text-xs ${style.body} opacity-70`}>
                First seen {new Date(alert.first_seen_at).toLocaleString()}
                {alert.occurrences > 1 &&
                  ` · last ${new Date(alert.last_seen_at).toLocaleTimeString()}`}
              </p>
            </div>

            {onAcknowledge && (
              <button
                type="button"
                onClick={() => onAcknowledge(alert.id)}
                aria-label="Dismiss alert"
                className={`shrink-0 rounded p-1 transition hover:bg-white/10 ${style.icon}`}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
