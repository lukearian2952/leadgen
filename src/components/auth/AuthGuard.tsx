import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { Spinner } from '../ui/Spinner'

export function AuthGuard({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" className="text-brand-500" />
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  return <>{children}</>
}
