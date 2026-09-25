import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BrowserRouter as Router, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { istNeuereServerVersion, istNeuererServiceWorker } from '@kassa/shared'
import { LoginPage }         from './pages/LoginPage'
import { KdsNachrichten }    from './components/KdsNachrichten'
import { TischePage }        from './pages/TischePage'
import { TabPage }           from './pages/TabPage'
import { ArtikelWaehlenPage } from './pages/ArtikelWaehlenPage'
import { getAuth }           from './lib/auth'
import { getKasseIdentity }  from './lib/kasse'
import { setOnUnauthorized, systemApi } from './lib/api'

export function App() {
  return (
    <Router>
      <UpdateHinweis />
      <AppRoutes />
    </Router>
  )
}

/**
 * Update-Hinweis — bewusst KEIN Auto-Reload (könnte eine laufende Bestellung
 * unterbrechen; der Kellner entscheidet). Zwei Erkennungswege:
 *
 *  1. Server-Version: Das Backend meldet eine NEUERE Version als dieses Bundle.
 *     Geprüft beim Start, alle 5 min, solange die Seite sichtbar ist, und beim
 *     Wieder-Sichtbarwerden (Handy entsperrt) — so erfährt auch eine dauerhaft
 *     offene Seite vom Update, auch ohne HTTPS, wo es keinen Service Worker gibt.
 *  2. controllerchange: Der SW einer NEUEREN Version hat übernommen (ein anderer
 *     Tab hat sie geladen). Übernimmt der SW der eigenen Version — der Normalfall
 *     nach einem Update —, ist das kein Hinweis wert.
 *
 * Neu laden genügt: der SW holt Seitenaufrufe übers Netz, ohne SW liefert nginx
 * index.html mit no-cache.
 *
 * Leiste ÜBER der Seite statt schwebend: unten stehen fest die wichtigsten
 * Knöpfe (Bar/Karte, „Zum Tab hinzufügen") — ein schwebender Hinweis läge
 * darauf, und ein Fehlgriff lädt neu und leert den Artikelkorb. Vollbild-Dialoge
 * wie die Kartenzahlung decken die Leiste ab.
 */
function UpdateHinweis() {
  const [swNeuer, setSwNeuer] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onChange = () => {
      if (istNeuererServiceWorker(navigator.serviceWorker.controller?.scriptURL, __APP_VERSION__)) {
        setSwNeuer(true)
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  // React Query fragt im Intervall nur bei sichtbarer Seite und beim
  // Sichtbarwerden (visibilitychange), sofern die letzte Antwort älter als
  // staleTime ist. Scheitert eine Abfrage (Backend startet gerade neu), bleibt
  // die letzte Antwort stehen.
  const server = useQuery({
    queryKey:             ['server-version'],
    queryFn:              () => systemApi.health(),
    refetchInterval:      5 * 60_000,
    refetchOnWindowFocus: true,
    staleTime:            60_000,
    retry:                false,
  })
  const serverNeuer = istNeuereServerVersion(server.data?.version, __APP_VERSION__)

  if (!swNeuer && !serverNeuer) return null

  return (
    <div role="status" className="border-b border-brand-200 bg-brand-50">
      <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-2">
        <span className="min-w-0 flex-1 text-sm font-bold text-brand-800">Neue Version verfügbar</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-black text-white active:scale-95 transition"
        >
          Jetzt aktualisieren
        </button>
      </div>
    </div>
  )
}

function AppRoutes() {
  const navigate = useNavigate()

  useEffect(() => {
    setOnUnauthorized(() => navigate('/login', { replace: true }))
  }, [navigate])

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/"            element={<RequireAuth><TischePage /></RequireAuth>} />
        <Route path="/tab/:tabId"  element={<RequireAuth><TabPage /></RequireAuth>} />
        <Route path="/tab/:tabId/artikel" element={<RequireAuth><ArtikelWaehlenPage /></RequireAuth>} />
        <Route path="*" element={getAuth()
          ? <Navigate to="/" replace />
          : <Navigate to={{ pathname: '/login', search: window.location.search }} replace />} />
      </Routes>
      {/* KDS→Kellner-Nachrichten: erst mit Anmeldung mounten (SSE braucht den
          Token; AppRoutes rendert bei jedem Routenwechsel neu, daher greift
          das direkt nach dem Login). */}
      {getAuth() && <KdsNachrichten />}
    </>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getAuth() || !getKasseIdentity()) {
    // Query-Parameter MITNEHMEN: der Einrichtungs-QR zeigt auf /?mandantId=… —
    // ohne search-Weitergabe verlor der Redirect die mandantId und die
    // Login-Seite hielt das Gerät für uneingerichtet (totes PIN-Feld).
    return <Navigate to={{ pathname: '/login', search: window.location.search }} replace />
  }
  return <>{children}</>
}
