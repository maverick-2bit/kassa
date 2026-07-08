import { useEffect, useState } from 'react'
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
      <UpdateHinweis />
    </Router>
  )
}

/** Neuer SW hat übernommen (= neue Version deployed) → Hinweis, KEIN Auto-Reload. */
function UpdateHinweis() {
  const [updateBereit, setUpdateBereit] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const hatteController = !!navigator.serviceWorker.controller
    const onChange = () => { if (hatteController) setUpdateBereit(true) }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  if (!updateBereit) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-2xl border border-brand-300 bg-panel px-4 py-2.5 shadow-lg">
      <span className="text-sm font-bold text-ink">Neue Version verfügbar</span>
      <button
        onClick={() => window.location.reload()}
        className="rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-black text-white active:scale-95 transition"
      >
        Jetzt aktualisieren
      </button>
    </div>
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
