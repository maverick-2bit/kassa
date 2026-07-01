import { Suspense, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import { getTheme, toggleTheme, type ThemeMode } from '../lib/theme'
import { useQueries } from '@tanstack/react-query'
import { clearAuth, getAuth, hasBerechtigung, hasModul } from '../lib/auth'
import { kasseApi } from '../lib/api'
import { KdsToasts } from './KdsToasts'
import { KdsNachrichten } from './KdsNachrichten'
import { OfflineStatusBar } from './OfflineStatusBar'
import { SeeStatusBanner } from './SeeStatusBanner'
import { FoStatusBanner } from './FoStatusBanner'
import { ErrorBoundary } from './ErrorBoundary'

export function Layout() {
  const location = useLocation()
  return (
    <div className="min-h-screen flex flex-col">
      <OfflineStatusBar />
      <SeeStatusBanner />
      <FoStatusBanner />
      <Header />
      <main className="flex-1">
        {/* ErrorBoundary pro Route: ein Defekt in einer Seite legt nicht die
            ganze Kasse lahm; Header/Nav bleiben bedienbar. resetKey=Pfad sorgt
            dafuer, dass der Fehler beim Wegnavigieren verschwindet. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink-muted" />
            </div>
          }>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <footer className="border-t border-line py-2 text-center">
        <span className="text-[11px] text-ink-subtle select-none">
          Kassa v{__APP_VERSION__}
        </span>
      </footer>
      <KdsToasts />
      <KdsNachrichten />
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
    <header className="bg-header text-white border-b border-black/20 sticky top-0 z-10">
      <div className="px-4 py-3 flex items-start gap-4">
        <div className="flex items-center gap-2 shrink-0 h-8">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </span>
          <span className="font-semibold text-white">Kassa</span>
        </div>
        <nav className="flex flex-wrap gap-1 flex-1 min-w-0">
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
          {hasBerechtigung('kasse')             && hasModul('mergeport')       && <NavItem to="/lieferungen">Lieferungen</NavItem>}
          {hasBerechtigung('kasse')             && hasModul('reservierungen')  && <NavItem to="/reservierungen">Reservierungen</NavItem>}
          {hasBerechtigung('einstellungen')     && hasModul('zeiterfassung')   && <NavItem to="/zeiterfassung">Zeiterfassung</NavItem>}
          {hasBerechtigung('einstellungen')     && hasModul('zeiterfassung')   && <NavItem to="/dienstplan">Dienstplan</NavItem>}
          {hasBerechtigung('kasse')             && hasModul('angebote')   && <NavItem to="/angebote">Angebote</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/belege">Belege</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/tagesabschluss">Abschluss</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/kassensturz">Kassensturz</NavItem>}
          {hasBerechtigung('belege.lesen')                                && <NavItem to="/berichte">Berichte</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/kassenbuch">Kassenbuch</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/einstellungen">Einstellungen</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/pos-konfiguration">POS-Konfig</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/kassen-startseite">Startseiten</NavItem>}
          {hasBerechtigung('einstellungen')     && hasModul('gastro')     && <NavItem to="/bonierdrucker">Bonierdrucker</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/dep-export">DEP-Export</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/bmd-export">BMD-Export</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/werbefolien">Werbefolien</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/finanzpruefung">Finanzprüfung</NavItem>}
          {hasBerechtigung('einstellungen')                               && <NavItem to="/module">Module</NavItem>}
          {hasBerechtigung('user.verwalten')                              && <NavItem to="/benutzer">Benutzer</NavItem>}
        </nav>
        {auth && (
          <div className="flex items-center gap-3 shrink-0 h-8">
            <JahresbelegHeaderChip />
            <ThemeToggle />
            <span className="hidden sm:inline text-[10px] font-mono text-white/50 select-none bg-white/10 px-1.5 py-0.5 rounded">
              v{__APP_VERSION__}
            </span>
            <div className="text-right text-xs">
              <p className="font-medium text-white">{auth.user.name}</p>
              <p className="text-white/60">{auth.mandant.firmenname}</p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="text-xs text-white/70 hover:text-white px-2 py-1 rounded hover:bg-white/10"
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
        `px-3 py-1.5 text-sm font-medium rounded-md transition shrink-0 whitespace-nowrap ${
          isActive
            ? 'bg-white/20 text-white'
            : 'text-white/70 hover:text-white hover:bg-white/10'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

/** Hell/Dunkel-Umschalter für die Kopfleiste. */
function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => getTheme())
  return (
    <button
      type="button"
      onClick={() => setMode(toggleTheme())}
      title={mode === 'dark' ? 'Zu hellem Modus wechseln' : 'Zu dunklem Modus wechseln'}
      aria-label="Farbschema umschalten"
      className="flex h-8 w-8 items-center justify-center rounded-md border border-white/25 bg-white/10 text-white hover:bg-white/20 transition"
    >
      {mode === 'dark' ? (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
        </svg>
      )}
    </button>
  )
}
