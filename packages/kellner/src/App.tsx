import { useEffect } from 'react'
import { BrowserRouter as Router, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { LoginPage }         from './pages/LoginPage'
import { TischePage }        from './pages/TischePage'
import { TabPage }           from './pages/TabPage'
import { ArtikelWaehlenPage } from './pages/ArtikelWaehlenPage'
import { getAuth }           from './lib/auth'
import { getKasseIdentity }  from './lib/kasse'
import { setOnUnauthorized } from './lib/api'

export function App() {
  return (
    <Router>
      <AppRoutes />
    </Router>
  )
}

function AppRoutes() {
  const navigate = useNavigate()

  useEffect(() => {
    setOnUnauthorized(() => navigate('/login', { replace: true }))
  }, [navigate])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/"            element={<RequireAuth><TischePage /></RequireAuth>} />
      <Route path="/tab/:tabId"  element={<RequireAuth><TabPage /></RequireAuth>} />
      <Route path="/tab/:tabId/artikel" element={<RequireAuth><ArtikelWaehlenPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to={getAuth() ? '/' : '/login'} replace />} />
    </Routes>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getAuth() || !getKasseIdentity()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
