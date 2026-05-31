import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { clearAuth, getAuth, hasBerechtigung, hasModul } from '../lib/auth'
import { kasseApi } from '../lib/api'
import { KdsToasts } from './KdsToasts'
import { OfflineStatusBar } from './OfflineStatusBar'

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <OfflineStatusBar />
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-gray-100 py-2 text-center">
        <span className="text-[11px] text-gray-400 select-none">
          Kassa v{__APP_VERSION__}
        </span>
      </footer>
      <KdsToasts />
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
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/dashboard">Dashboard</NavItem>}
          {hasBerechtigung('tische')            && hasModul('gastro')    && <NavItem to="/tische">Tische</NavItem>}
          {hasBerechtigung('kasse')                                       && <NavItem to="/kasse">Kasse</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/artikel">Artikel</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/wareneingang">Wareneingang</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/lagerstand">Lagerstand</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/modifikatoren">Optionen</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/bestellliste">Bestellliste</NavItem>}
          {hasBerechtigung('artikel.verwalten')                           && <NavItem to="/lieferanten">Lieferanten</NavItem>}
          {hasBerechtigung('kunden.verwalten')                            && <NavItem to="/kunden">Kunden</NavItem>}
          {hasBerechtigung('kunden.verwalten')                            && <NavItem to="/offene-posten">Offene Posten</NavItem>}
          {hasBerechtigung('kasse')                                       && <NavItem to="/gutscheine">Gutscheine</NavItem>}
          {hasBerechtigung('kasse')             && hasModul('mergeport')  && <NavItem to="/lieferungen">Lieferungen</NavItem>}
          {hasBerechtigung('kasse')             && hasModul('angebote')   && <NavItem to="/angebote">Angebote</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/belege">Belege</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/tagesabschluss">Abschluss</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/kassensturz">Kassensturz</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/berichte">Berichte</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/kassenbuch">Kassenbuch</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/einstellungen">Einstellungen</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/pos-konfiguration">POS-Konfig</NavItem>}
          {hasBerechtigung('einstellungen')     && hasModul('gastro')     && <NavItem to="/bonierdrucker">Bonierdrucker</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/dep-export">DEP-Export</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/finanzpruefung">Finanzprüfung</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/module">Module</NavItem>}
          {hasBerechtigung('user.verwalten')                              && <NavItem to="/benutzer">Benutzer</NavItem>}
        </nav>
        {auth && (
          <div className="flex items-center gap-3">
            <JahresbelegHeaderChip />
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

/**
 * Kleiner Warnchip im Header, der erscheint, sobald für mindestens eine Kasse
 * kein Jahresbeleg für das laufende Kalenderjahr existiert.
 * Zeigt nur eine Warnung — kein Laden-Spinner — um den Header nicht zu stören.
 */
function JahresbelegHeaderChip() {
  const auth      = getAuth()
  const kassen    = auth?.kassen ?? []
  const darfSehen = hasBerechtigung('belege.lesen')

  // useQueries muss immer aufgerufen werden (Rules of Hooks).
  // enabled: false verhindert tatsächliche Requests, wenn keine Berechtigung.
  const results = useQueries({
    queries: kassen.map(k => ({
      queryKey:        ['jahresbeleg-status', k.id],
      queryFn:         () => kasseApi.getJahresbelegStatus(k.id),
      staleTime:       5 * 60_000,
      refetchInterval: 60_000,
      enabled:         darfSehen,
    })),
  })

  if (!darfSehen || kassen.length === 0) return null

  const anyFaellig = results.some(r => r.data?.jahresbelegFaellig === true)
  if (!anyFaellig) return null

  const tagDesJahres =
    Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86_400_000) + 1
  const ueberfaellig = tagDesJahres > 7

  return (
    <Link
      to="/belege"
      title="Jahresbeleg fällig — Zur Belegseite"
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition ${
        ueberfaellig
          ? 'bg-red-100 text-red-700 hover:bg-red-200'
          : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
      }`}
    >
      <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
      Jahresbeleg
    </Link>
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
