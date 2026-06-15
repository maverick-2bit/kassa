import { lazy, Suspense, useEffect, type ComponentType } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import type { Berechtigung, MandantModul } from '@kassa/shared'
import { getAuth, hasBerechtigung, hasModul, setOnUnauthorized } from './lib/auth'
import { getKasseIdentity } from './lib/kasse'

// ---------------------------------------------------------------------------
// Seiten werden per React.lazy code-gesplittet — jede Seite landet in einem
// eigenen Chunk, der erst beim Navigieren geladen wird. Das haelt das
// Initial-Bundle klein. Die Seiten exportieren named (kein default), daher das
// .then(m => ({ default: m.X }))-Mapping.
// ---------------------------------------------------------------------------
const lazyPage = <K extends string>(
  loader: () => Promise<Record<K, ComponentType>>,
  name: K,
) => lazy(() => loader().then(m => ({ default: m[name] })))

const SetupPage                 = lazyPage(() => import('./pages/SetupPage'), 'SetupPage')
const LoginPage                 = lazyPage(() => import('./pages/LoginPage'), 'LoginPage')
const KassePage                 = lazyPage(() => import('./pages/KassePage'), 'KassePage')
const ArtikelPage               = lazyPage(() => import('./pages/ArtikelPage'), 'ArtikelPage')
const BelegePage                = lazyPage(() => import('./pages/BelegePage'), 'BelegePage')
const EinstellungenPage         = lazyPage(() => import('./pages/EinstellungenPage'), 'EinstellungenPage')
const TischePage                = lazyPage(() => import('./pages/TischePage'), 'TischePage')
const TischTabPage              = lazyPage(() => import('./pages/TischTabPage'), 'TischTabPage')
const UserVerwaltungPage        = lazyPage(() => import('./pages/UserVerwaltungPage'), 'UserVerwaltungPage')
const TagesabschlussPage        = lazyPage(() => import('./pages/TagesabschlussPage'), 'TagesabschlussPage')
const BerichtePage              = lazyPage(() => import('./pages/BerichtePage'), 'BerichtePage')
const WareneingangPage          = lazyPage(() => import('./pages/WareneingangPage'), 'WareneingangPage')
const LagerstandPage            = lazyPage(() => import('./pages/LagerstandPage'), 'LagerstandPage')
const OffenePostenPage          = lazyPage(() => import('./pages/OffenePostenPage'), 'OffenePostenPage')
const GutscheinPage             = lazyPage(() => import('./pages/GutscheinPage'), 'GutscheinPage')
const LieferungenPage           = lazyPage(() => import('./pages/LieferungenPage'), 'LieferungenPage')
const MandantenEinstellungenPage = lazyPage(() => import('./pages/MandantenEinstellungenPage'), 'MandantenEinstellungenPage')
const DashboardPage             = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage')
const KundenPage                = lazyPage(() => import('./pages/KundenPage'), 'KundenPage')
const AngebotePage              = lazyPage(() => import('./pages/AngebotePage'), 'AngebotePage')
const KassensturzPage           = lazyPage(() => import('./pages/KassensturzPage'), 'KassensturzPage')
const BonierdruckerPage         = lazyPage(() => import('./pages/BonierdruckerPage'), 'BonierdruckerPage')
const KassenbuchPage            = lazyPage(() => import('./pages/KassenbuchPage'), 'KassenbuchPage')
const PosKonfigPage             = lazyPage(() => import('./pages/PosKonfigPage'), 'PosKonfigPage')
const KassenStartseiteSeite     = lazyPage(() => import('./pages/KassenStartseiteSeite'), 'KassenStartseiteSeite')
const DepExportPage             = lazyPage(() => import('./pages/DepExportPage'), 'DepExportPage')
const FinanzpruefungPage        = lazyPage(() => import('./pages/FinanzpruefungPage'), 'FinanzpruefungPage')
const PruefungsansichtPage      = lazyPage(() => import('./pages/PruefungsansichtPage'), 'PruefungsansichtPage')
const LieferantenPage           = lazyPage(() => import('./pages/LieferantenPage'), 'LieferantenPage')
const BestelllistePage          = lazyPage(() => import('./pages/BestelllistePage'), 'BestelllistePage')
const ModifikatorenPage         = lazyPage(() => import('./pages/ModifikatorenPage'), 'ModifikatorenPage')
const ReservierungenPage        = lazyPage(() => import('./pages/ReservierungenPage'), 'ReservierungenPage')
const OnlineBuchungPage         = lazyPage(() => import('./pages/OnlineBuchungPage'), 'OnlineBuchungPage')
const ZeiterfassungPage         = lazyPage(() => import('./pages/ZeiterfassungPage'), 'ZeiterfassungPage')
const ExportPage                = lazyPage(() => import('./pages/ExportPage'), 'ExportPage')
const WerbefolienPage           = lazyPage(() => import('./pages/WerbefolienPage'), 'WerbefolienPage')
const DienstplanPage            = lazyPage(() => import('./pages/DienstplanPage'), 'DienstplanPage')
const SelfCheckoutPage          = lazyPage(() => import('./pages/SelfCheckoutPage'), 'SelfCheckoutPage')

export function App() {
  return (
    <Router>
      <AppRoutes />
    </Router>
  )
}

/** Ladeanzeige, waehrend ein Seiten-Chunk nachgeladen wird. */
function SeitenLader() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
    </div>
  )
}

function AppRoutes() {
  const navigate = useNavigate()

  // Bei 401 → Redirect zu /login (global registriert)
  useEffect(() => {
    setOnUnauthorized(() => navigate('/login'))
  }, [navigate])

  return (
    <Suspense fallback={<SeitenLader />}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/buchung"      element={<OnlineBuchungPage />} />
        <Route path="/selfcheckout" element={<SelfCheckoutPage />} />
        <Route path="/pruefung/:token" element={<PruefungsansichtPage />} />
        <Route element={<Layout />}>
          <Route path="/dashboard"        element={<Require b="belege.lesen"                 ><DashboardPage /></Require>} />
          <Route path="/tische"         element={<Require b="tische"          m="gastro"   ><TischePage /></Require>} />
          <Route path="/tische/:tabId"  element={<Require b="tische"          m="gastro"   ><TischTabPage /></Require>} />
          <Route path="/kasse"          element={<Require b="kasse"                        ><KassePage /></Require>} />
          <Route path="/artikel"        element={<Require b="artikel.verwalten"            ><ArtikelPage /></Require>} />
          <Route path="/wareneingang"   element={<Require b="artikel.verwalten"            ><WareneingangPage /></Require>} />
          <Route path="/lagerstand"     element={<Require b="artikel.verwalten"            ><LagerstandPage /></Require>} />
          <Route path="/modifikatoren"    element={<Require b="artikel.verwalten"            ><ModifikatorenPage /></Require>} />
          <Route path="/pos-konfiguration" element={<Require b="einstellungen"             ><PosKonfigPage /></Require>} />
          <Route path="/bonierdrucker"     element={<Require b="einstellungen"  m="gastro" ><BonierdruckerPage /></Require>} />
          <Route path="/belege"         element={<Require b="belege.lesen"                 ><BelegePage /></Require>} />
          <Route path="/einstellungen"  element={<Require b="einstellungen"                ><EinstellungenPage /></Require>} />
          <Route path="/module"         element={<Require b="einstellungen"                ><MandantenEinstellungenPage /></Require>} />
          <Route path="/benutzer"       element={<Require b="user.verwalten"               ><UserVerwaltungPage /></Require>} />
          <Route path="/tagesabschluss" element={<Require b="belege.lesen"                 ><TagesabschlussPage /></Require>} />
          <Route path="/kassensturz"    element={<Require b="belege.lesen"                 ><KassensturzPage /></Require>} />
          <Route path="/kassenbuch"     element={<Require b="einstellungen"                ><KassenbuchPage /></Require>} />
          <Route path="/berichte"       element={<Require b="belege.lesen"                 ><BerichtePage /></Require>} />
          <Route path="/kunden"         element={<Require b="kunden.verwalten"             ><KundenPage /></Require>} />
          <Route path="/angebote"       element={<Require b="kasse"            m="angebote"><AngebotePage /></Require>} />
          <Route path="/offene-posten"  element={<Require b="kunden.verwalten"             ><OffenePostenPage /></Require>} />
          <Route path="/gutscheine"     element={<Require b="kasse"                        ><GutscheinPage /></Require>} />
          <Route path="/lieferungen"     element={<Require b="kasse"            m="mergeport"      ><LieferungenPage /></Require>} />
          <Route path="/reservierungen"  element={<Require b="kasse"            m="reservierungen" ><ReservierungenPage /></Require>} />
          <Route path="/zeiterfassung"   element={<Require b="einstellungen"    m="zeiterfassung"  ><ZeiterfassungPage /></Require>} />
          <Route path="/lieferanten"    element={<Require b="artikel.verwalten"            ><LieferantenPage /></Require>} />
          <Route path="/bestellliste"   element={<Require b="artikel.verwalten"            ><BestelllistePage /></Require>} />
          <Route path="/dep-export"           element={<Require b="einstellungen"                ><DepExportPage /></Require>} />
          <Route path="/bmd-export"           element={<Require b="einstellungen"                ><ExportPage /></Require>} />
          <Route path="/werbefolien"           element={<Require b="einstellungen"                ><WerbefolienPage /></Require>} />
          <Route path="/dienstplan"            element={<Require b="einstellungen"    m="zeiterfassung" ><DienstplanPage /></Require>} />
          <Route path="/finanzpruefung"      element={<Require b="einstellungen"                ><FinanzpruefungPage /></Require>} />
          <Route path="/kassen-startseite"   element={<Require b="einstellungen"                ><KassenStartseiteSeite /></Require>} />
        </Route>
        <Route path="*" element={<Navigate to={getInitialRoute()} replace />} />
      </Routes>
    </Suspense>
  )
}

function getInitialRoute(): string {
  // Niemand eingeloggt? → Login (falls Kasse bereits eingerichtet) oder Setup
  if (!getAuth()) {
    return getKasseIdentity() ? '/login' : '/setup'
  }
  // Erste erreichbare Seite je nach Berechtigung + aktivem Modul
  if (hasBerechtigung('tische') && hasModul('gastro'))    return '/tische'
  if (hasBerechtigung('kasse'))                           return '/kasse'
  if (hasBerechtigung('belege.lesen'))                    return '/belege'
  if (hasBerechtigung('artikel.verwalten'))               return '/artikel'
  if (hasBerechtigung('einstellungen'))                   return '/einstellungen'
  if (hasBerechtigung('user.verwalten'))                  return '/benutzer'
  return '/login'  // User ohne jegliche Berechtigung — sollte nicht vorkommen
}

function Require({ b, m, children }: { b: Berechtigung; m?: MandantModul; children: React.ReactNode }) {
  if (!getAuth()) return <Navigate to="/login" replace />
  if (!hasBerechtigung(b)) return <Navigate to={getInitialRoute()} replace />
  if (m && !hasModul(m)) return <Navigate to={getInitialRoute()} replace />
  return <>{children}</>
}
