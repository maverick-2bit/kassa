import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { clearAuth, getAuth } from '../lib/auth'

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}

function Header() {
  const navigate = useNavigate()
  const auth     = getAuth()

  const logout = () => {
    clearAuth()
    navigate('/login')
  }

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </span>
          <span className="font-semibold text-gray-900">Kassa</span>
        </div>
        <nav className="flex gap-1 flex-1">
          <NavItem to="/kasse">Kasse</NavItem>
          <NavItem to="/artikel">Artikel</NavItem>
          <NavItem to="/belege">Belege</NavItem>
          <NavItem to="/einstellungen">Einstellungen</NavItem>
        </nav>
        {auth && (
          <div className="flex items-center gap-3">
            <div className="text-right text-xs">
              <p className="font-medium text-gray-900">{auth.user.name}</p>
              <p className="text-gray-500">{auth.mandant.firmenname}</p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="text-xs text-gray-500 hover:text-red-600 px-2 py-1 rounded hover:bg-gray-100"
              title="Abmelden"
            >
              Abmelden
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

function NavItem({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 py-1.5 text-sm font-medium rounded-md transition ${
          isActive
            ? 'bg-brand-50 text-brand-700'
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
        }`
      }
    >
      {children}
    </NavLink>
  )
}
