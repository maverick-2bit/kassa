import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom'
import { getTheme, toggleTheme, type ThemeMode } from '../lib/theme'
import { useQueries } from '@tanstack/react-query'
import { clearAuth, getAuth, hasBerechtigung, hasModul } from '../lib/auth'
import { kasseApi } from '../lib/api'
import { KdsToasts } from './KdsToasts'
import { KdsNachrichten } from './KdsNachrichten'
import { OfflineStatusBar } from './OfflineStatusBar'
import { UpdateHinweis } from './UpdateHinweis'
import { SeeStatusBanner } from './SeeStatusBanner'
import { FoStatusBanner } from './FoStatusBanner'
import { ErrorBoundary } from './ErrorBoundary'

export function Layout() {
  const location = useLocation()
  return (
    <div className="min-h-screen flex flex-col">
      <OfflineStatusBar />
      <UpdateHinweis />
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

type NavEintrag = { to: string; label: string }
type NavGruppe  = { label: string; items: NavEintrag[] }

/** Nav-Struktur aufbauen — jeder Eintrag nur, wenn Berechtigung + Modul passen. */
function baueNavGruppen(): NavGruppe[] {
  const b = hasBerechtigung
  const m = hasModul
  const wenn = (cond: boolean, to: string, label: string): NavEintrag | null =>
    cond ? { to, label } : null
  const gruppe = (label: string, items: (NavEintrag | null)[]): NavGruppe =>
    ({ label, items: items.filter((x): x is NavEintrag => x !== null) })

  return [
    gruppe('Verkauf', [
      wenn(b('tische') && m('gastro'),         '/tische',         'Tische'),
      wenn(b('kasse'),                          '/kasse',          'Kasse'),
      wenn(b('kasse'),                          '/gutscheine',     'Gutscheine'),
      wenn(b('kasse') && m('mergeport'),        '/lieferungen',    'Lieferungen'),
      wenn(b('kasse') && m('reservierungen'),   '/reservierungen', 'Reservierungen'),
      wenn(b('kasse') && m('angebote'),         '/angebote',       'Angebote'),
      wenn(b('kasse') && m('sbTerminal'),       '/sb-bestellungen', 'SB-Bestellungen'),
    ]),
    gruppe('Artikel & Lager', [
      wenn(b('artikel.verwalten'), '/artikel',      'Artikel'),
      wenn(b('artikel.verwalten'), '/wareneingang', 'Wareneingang'),
      wenn(b('artikel.verwalten'), '/lagerstand',   'Lagerstand'),
      wenn(b('artikel.verwalten'), '/modifikatoren', 'Optionen'),
      wenn(b('artikel.verwalten'), '/preisregeln',  'Happy Hour'),
      wenn(b('artikel.verwalten'), '/bestellliste', 'Bestellliste'),
      wenn(b('artikel.verwalten'), '/lieferanten',  'Lieferanten'),
    ]),
    gruppe('Kunden', [
      wenn(b('kunden.verwalten'), '/kunden',        'Kunden'),
      wenn(b('kunden.verwalten'), '/offene-posten', 'Offene Posten'),
    ]),
    gruppe('Auswertung', [
      wenn(b('belege.lesen'),   '/belege',        'Belege'),
      wenn(b('belege.lesen'),   '/tagesabschluss', 'Abschluss'),
      wenn(b('belege.lesen'),   '/kassensturz',   'Kassensturz'),
      wenn(b('belege.lesen'),   '/berichte',      'Berichte'),
      wenn(b('einstellungen'),  '/kassenbuch',    'Kassenbuch'),
    ]),
    gruppe('Personal', [
      wenn(b('einstellungen') && m('zeiterfassung'), '/zeiterfassung', 'Zeiterfassung'),
      wenn(b('einstellungen') && m('zeiterfassung'), '/dienstplan',    'Dienstplan'),
      wenn(b('user.verwalten'),                       '/benutzer',      'Benutzer'),
    ]),
    gruppe('Einstellungen', [
      wenn(b('einstellungen'),                    '/einstellungen',     'Einstellungen'),
      wenn(b('einstellungen'),                    '/pos-konfiguration', 'POS-Konfig'),
      wenn(b('einstellungen'),                    '/kassen-startseite', 'Startseiten'),
      wenn(b('einstellungen'),                    '/dep-export',        'DEP-Export'),
      wenn(b('einstellungen'),                    '/bmd-export',        'BMD-Export'),
      wenn(b('einstellungen'),                    '/werbefolien',       'Werbefolien'),
      wenn(b('einstellungen'),                    '/finanzpruefung',    'Finanzprüfung'),
      wenn(b('einstellungen'),                    '/module',            'Module'),
    ]),
  ].filter(g => g.items.length > 0)
}

function Header() {
  const navigate = useNavigate()
  const location = useLocation()
  const auth     = getAuth()
  const [offen, setOffen] = useState<string | null>(null)
  const navRef = useRef<HTMLElement>(null)

  // Dropdown schließen bei Navigation und bei Klick außerhalb der Nav
  useEffect(() => { setOffen(null) }, [location.pathname])
  useEffect(() => {
    if (!offen) return
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOffen(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [offen])

  const logout = () => {
    clearAuth()
    navigate('/login')
  }

  const gruppen = auth ? baueNavGruppen() : []

  return (
    <header className="bg-header text-white border-b border-black/20 sticky top-0 z-20">
      <div className="px-4 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2 shrink-0 h-8">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </span>
          <span className="font-semibold text-white">Kassa</span>
        </div>
        {auth && (
          <nav ref={navRef} className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
            {hasBerechtigung('belege.lesen') && <NavItem to="/dashboard">Dashboard</NavItem>}
            {gruppen.map(g => (
              <NavGruppeMenu
                key={g.label}
                gruppe={g}
                offen={offen === g.label}
                onToggle={() => setOffen(o => (o === g.label ? null : g.label))}
              />
            ))}
          </nav>
        )}
        {!auth && <div className="flex-1" />}
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

/** Gruppen-Menü in der Kopfleiste: Button + aufklappbares Dropdown mit den Einträgen. */
function NavGruppeMenu({ gruppe, offen, onToggle }: { gruppe: NavGruppe; offen: boolean; onToggle: () => void }) {
  const location = useLocation()
  const aktiv = gruppe.items.some(
    i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'),
  )
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={offen}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md transition whitespace-nowrap ${
          aktiv || offen ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
        }`}
      >
        {gruppe.label}
        <svg className={`h-3.5 w-3.5 transition-transform ${offen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {offen && (
        <div className="absolute left-0 top-full mt-1 min-w-[12rem] rounded-lg border border-line bg-panel shadow-lg py-1 z-30">
          {gruppe.items.map(i => (
            <NavLink
              key={i.to}
              to={i.to}
              className={({ isActive }) =>
                `block px-3 py-2 text-sm transition ${
                  isActive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink hover:bg-panel-2'
                }`
              }
            >
              {i.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
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
