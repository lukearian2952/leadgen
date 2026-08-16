interface Props {
  value: number  // 0-100
  className?: string
  color?: 'blue' | 'green' | 'yellow'
}

const colorClasses = {
  blue:   'bg-brand-500',
  green:  'bg-green-500',
  yellow: 'bg-yellow-500',
}

export function ProgressBar({ value, className = '', color = 'blue' }: Props) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-gray-800 ${className}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${colorClasses[color]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
