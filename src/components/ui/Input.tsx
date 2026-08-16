import type { InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export function Input({ label, error, hint, className = '', id, ...props }: Props) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-300">
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...props}
        className={`
          w-full rounded-lg border bg-gray-900 px-3 py-2 text-sm text-gray-100
          placeholder-gray-600 transition-colors
          border-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500
          disabled:opacity-50 disabled:cursor-not-allowed
          ${error ? 'border-red-600' : ''} ${className}
        `}
      />
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
