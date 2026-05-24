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
import { BonierdruckerPage } from './pages/BonierdruckerPage'
import { PosKonfigPage } from './pages/PosKonfigPage'
import type { Berechtigung } from '@kassa/shared'
import { getAuth, hasBerechtigung, setOnUnauthorized } from './lib/auth'
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
      <Route element={<Layout />}>
        <Route path="/tische"         element={<Require b="tische"><TischePage /></Require>} />
        <Route path="/tische/:tabId"  element={<Require b="tische"><TischTabPage /></Require>} />
        <Route path="/kasse"          element={<Require b="kasse"><KassePage /></Require>} />
        <Route path="/artikel"        element={<Require b="artikel.verwalten"><ArtikelPage /></Require>} />
        <Route path="/wareneingang"   element={<Require b="artikel.verwalten"><WareneingangPage /></Require>} />
        <Route path="/pos-konfiguration" element={<Require b="einstellungen"><PosKonfigPage /></Require>} />
        <Route path="/bonierdrucker"     element={<Require b="einstellungen"><BonierdruckerPage /></Require>} />
        <Route path="/belege"         element={<Require b="belege.lesen"><BelegePage /></Require>} />
        <Route path="/einstellungen"  element={<Require b="einstellungen"><EinstellungenPage /></Require>} />
        <Route path="/benutzer"          element={<Require b="user.verwalten"><UserVerwaltungPage /></Require>} />
        <Route path="/tagesabschluss"   element={<Require b="belege.lesen"><TagesabschlussPage /></Require>} />
        <Route path="/berichte"         element={<Require b="belege.lesen"><BerichtePage /></Require>} />
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
  // Erste erreichbare Seite je nach Berechtigung — Tische ist Default für Gastro
  if (hasBerechtigung('tische'))            return '/tische'
  if (hasBerechtigung('kasse'))             return '/kasse'
  if (hasBerechtigung('belege.lesen'))      return '/belege'
  if (hasBerechtigung('artikel.verwalten')) return '/artikel'
  if (hasBerechtigung('einstellungen'))     return '/einstellungen'
  if (hasBerechtigung('user.verwalten'))    return '/benutzer'
  return '/login'  // User ohne jegliche Berechtigung — sollte nicht vorkommen
}

function Require({ b, children }: { b: Berechtigung; children: React.ReactNode }) {
  if (!getAuth()) return <Navigate to="/login" replace />
  if (!hasBerechtigung(b)) return <Navigate to={getInitialRoute()} replace />
  return <>{children}</>
}
