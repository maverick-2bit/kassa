/**
 * Update-Hinweis — zwei Erkennungswege, bewusst KEIN Auto-Reload (könnte einen
 * laufenden Verkauf unterbrechen; der Kassier entscheidet):
 *
 *  1. controllerchange: Ein neuer Service Worker hat die Kontrolle übernommen,
 *     während die Seite offen war (schneller Pfad direkt nach einem Deploy).
 *  2. Bundle-Drift: Das Backend meldet eine neuere installierte Version als
 *     dieses Bundle (__APP_VERSION__). Deckt Kiosk-Kassen ab, deren Seite
 *     dauerhaft offen steht — dort feuert der SW-Update-Check von allein nie.
 *     Der Poll stößt zugleich registration.update() an, damit der Reload
 *     anschließend wirklich das neue Bundle lädt.
 */

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { systemApi } from '../lib/api'

export function UpdateHinweis() {
  const [updateBereit, setUpdateBereit] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // Nur echte Updates melden: beim Erst-Install gibt es noch keinen Controller.
    const hatteController = !!navigator.serviceWorker.controller
    const onChange = () => { if (hatteController) setUpdateBereit(true) }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  const status = useQuery({
    queryKey:             ['system-status-bundle-drift'],
    queryFn:              systemApi.status,
    refetchInterval:      5 * 60_000,
    refetchOnWindowFocus: true,
    staleTime:            60_000,
  })
  const backendVersion = status.data?.installiert
  const bundleVeraltet = !!backendVersion && backendVersion !== __APP_VERSION__

  useEffect(() => {
    if (!bundleVeraltet || !('serviceWorker' in navigator)) return
    void navigator.serviceWorker.getRegistration().then(r => r?.update())
  }, [bundleVeraltet])

  if (!updateBereit && !bundleVeraltet) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-xl border border-brand-300 bg-brand-50 px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium text-brand-800">
        {bundleVeraltet
          ? `Version v${backendVersion} ist installiert — diese Ansicht läuft noch auf v${__APP_VERSION__}`
          : 'Neue Version verfügbar'}
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Jetzt aktualisieren
      </button>
    </div>
  )
}
