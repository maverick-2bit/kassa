import { useEffect } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { SetupPage } from './pages/SetupPage'
import { LoginPage } from './pages/LoginPage'
import { KassePage } from './pages/KassePage'
import { ArtikelPage } from './pages/ArtikelPage'
import { BelegePage } from './pages/BelegePage'
import { EinstellungenPage } from './pages/EinstellungenPage'
import { TischePage } from './pages/TischePage'
import { TischTabPage } from './pages/TischTabPage'
import { UserVerwaltungPage } from './pages/UserVerwaltungPage'
import { TagesabschlussPage } from './pages/TagesabschlussPage'
import { BerichtePage } from './pages/BerichtePage'
import { WareneingangPage } from './pages/WareneingangPage'
import { LagerstandPage } from './pages/LagerstandPage'
import { OffenePostenPage } from './pages/OffenePostenPage'
import { GutscheinPage } from './pages/GutscheinPage'
import { LieferungenPage } from './pages/LieferungenPage'
import { MandantenEinstellungenPage } from './pages/MandantenEinstellungenPage'
import { DashboardPage } from './pages/DashboardPage'
import { KundenPage } from './pages/KundenPage'
import { AngebotePage } from './pages/AngebotePage'
import { KassensturzPage } from './pages/KassensturzPage'
import { BonierdruckerPage } from './pages/BonierdruckerPage'
import { KassenbuchPage } from './pages/KassenbuchPage'
import { PosKonfigPage } from './pages/PosKonfigPage'
import { KassenStartseiteSeite } from './pages/KassenStartseiteSeite'
import { DepExportPage } from './pages/DepExportPage'
import { FinanzpruefungPage } from './pages/FinanzpruefungPage'
import { PruefungsansichtPage } from './pages/PruefungsansichtPage'
import { LieferantenPage } from './pages/LieferantenPage'
import { BestelllistePage } from './pages/BestelllistePage'
import { ModifikatorenPage } from './pages/ModifikatorenPage'
import { ReservierungenPage } from './pages/ReservierungenPage'
import { OnlineBuchungPage } from './pages/OnlineBuchungPage'
import { ZeiterfassungPage } from './pages/ZeiterfassungPage'
import type { Berechtigung, MandantModul } from '@kassa/shared'
import { getAuth, hasBerechtigung, hasModul, setOnUnauthorized } from './lib/auth'
import { getKasseIdentity } from './lib/kasse'

export function App() {
  return (
    <Router>
      <AppRoutes />
    </Router>
  )
}

function AppRoutes() {
  const navigate = useNavigate()

  // Bei 401 → Redirect zu /login (global registriert)
  useEffect(() => {
    setOnUnauthorized(() => navigate('/login'))
  }, [navigate])

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/buchung" element={<OnlineBuchungPage />} />
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
        <Route path="/finanzpruefung"      element={<Require b="einstellungen"                ><FinanzpruefungPage /></Require>} />
        <Route path="/kassen-startseite"   element={<Require b="einstellungen"                ><KassenStartseiteSeite /></Require>} />
      </Route>
      <Route path="*" element={<Navigate to={getInitialRoute()} replace />} />
    </Routes>
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
