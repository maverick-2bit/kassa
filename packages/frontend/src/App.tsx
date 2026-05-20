import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { SetupPage } from './pages/SetupPage'
import { KassePage } from './pages/KassePage'
import { ArtikelPage } from './pages/ArtikelPage'
import { BelegePage } from './pages/BelegePage'
import { getKasseIdentity } from './lib/kasse'

export function App() {
  return (
    <Router>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route element={<Layout />}>
          <Route path="/kasse"   element={<RequireSetup><KassePage /></RequireSetup>} />
          <Route path="/artikel" element={<RequireSetup><ArtikelPage /></RequireSetup>} />
          <Route path="/belege"  element={<RequireSetup><BelegePage /></RequireSetup>} />
        </Route>
        <Route path="*" element={<Navigate to={getKasseIdentity() ? '/kasse' : '/setup'} replace />} />
      </Routes>
    </Router>
  )
}

function RequireSetup({ children }: { children: React.ReactNode }) {
  const identity = getKasseIdentity()
  if (!identity) return <Navigate to="/setup" replace />
  return <>{children}</>
}
