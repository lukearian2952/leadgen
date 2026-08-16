import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  children: ReactNode
}

const variantClasses = {
  primary:   'bg-brand-600 hover:bg-brand-700 text-white border-transparent',
  secondary: 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700',
  danger:    'bg-red-700 hover:bg-red-600 text-white border-transparent',
  ghost:     'bg-transparent hover:bg-gray-800 text-gray-400 hover:text-gray-200 border-transparent',
}

const sizeClasses = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
}

export function Button({ variant = 'primary', size = 'md', loading, children, className = '', disabled, ...props }: Props) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 rounded-lg border font-medium
        transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-gray-950
        disabled:opacity-50 disabled:cursor-not-allowed
        ${variantClasses[variant]} ${sizeClasses[size]} ${className}
      `}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  )
}
