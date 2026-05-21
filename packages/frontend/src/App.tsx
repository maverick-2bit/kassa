import { useEffect } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { SetupPage } from './pages/SetupPage'
import { LoginPage } from './pages/LoginPage'
import { KassePage } from './pages/KassePage'
import { ArtikelPage } from './pages/ArtikelPage'
import { BelegePage } from './pages/BelegePage'
import { EinstellungenPage } from './pages/EinstellungenPage'
import { getAuth, setOnUnauthorized } from './lib/auth'
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
        <Route path="/kasse"         element={<RequireAuth><KassePage /></RequireAuth>} />
        <Route path="/artikel"       element={<RequireAuth><ArtikelPage /></RequireAuth>} />
        <Route path="/belege"        element={<RequireAuth><BelegePage /></RequireAuth>} />
        <Route path="/einstellungen" element={<RequireAuth><EinstellungenPage /></RequireAuth>} />
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
  return '/kasse'
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getAuth()) return <Navigate to="/login" replace />
  return <>{children}</>
}
