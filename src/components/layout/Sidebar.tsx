import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Plus, Zap } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'

const navItems = [
  { to: '/',    icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/new', icon: Plus,            label: 'New Campaign' },
]

export function Sidebar() {
  const { signOut } = useAuth()

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-gray-800 bg-gray-950">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2.5 border-b border-gray-800 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
          <Zap size={16} className="text-white" />
        </div>
        <span className="text-sm font-semibold text-gray-100">LeadGen</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-3">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-gray-800 text-gray-100'
                  : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Sign out */}
      <div className="border-t border-gray-800 p-3">
        <button
          onClick={() => signOut()}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-500 hover:bg-gray-900 hover:text-gray-300 transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
