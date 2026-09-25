/**
 * Update-Hinweis — zwei Erkennungswege, bewusst KEIN Auto-Reload (könnte einen
 * laufenden Verkauf unterbrechen; der Kassier entscheidet):
 *
 *  1. controllerchange: Der Service Worker einer NEUEREN Version hat die
 *     Kontrolle übernommen, während die Seite offen war (schneller Pfad direkt
 *     nach einem Deploy). Übernimmt der SW der eigenen Version — der Normalfall
 *     beim ersten Laden nach einem Update —, ist das kein Hinweis wert.
 *  2. Bundle-Drift: Das Backend meldet eine neuere installierte Version als
 *     dieses Bundle (__APP_VERSION__). Deckt Kiosk-Kassen ab, deren Seite
 *     dauerhaft offen steht — dort feuert der SW-Update-Check von allein nie.
 *     Der Poll stößt zugleich registration.update() an, damit der Reload
 *     anschließend wirklich das neue Bundle lädt.
 *
 * Sitzt in der Kopfleiste an der Stelle des Versions-Badges: Solange nichts
 * ansteht, steht dort das Badge (children), sonst der Knopf „Neu laden".
 * Bewusst nicht schwebend: Unten mittig lag der Hinweis am POS auf „Bar" und
 * „Leeren" und über jedem Dialog — auch über der laufenden Kartenzahlung. Ein
 * Fehlgriff lädt neu und verwirft den Warenkorb. Die Kopfleiste liegt unter
 * allen Dialogen, verdeckt nichts und schiebt die Seite nicht nach unten.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { istNeuererServiceWorker } from '@kassa/shared'
import { systemApi } from '../lib/api'

/**
 * Holt das neue Bundle wirklich — ein blosses reload() genügt nicht.
 *
 * Der alte Service Worker beantwortet die Navigation aus seinem Cache und
 * liefert damit endlos dasselbe Bundle. Darum erst die versionierten
 * kassa-*-Caches leeren und die Registrierung entfernen; die nächste Ladung
 * geht dann am SW vorbei ans Netz, das neue Bundle registriert sich selbst neu.
 *
 * Die Offline-Warteschlange liegt in IndexedDB und bleibt dabei unberührt.
 */
async function aktualisieren(setLaeuft: (v: boolean) => void): Promise<void> {
  setLaeuft(true)
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.filter(k => k.startsWith('kassa-')).map(k => caches.delete(k)))
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
  } catch {
    /* Aufräumen darf den Reload nicht verhindern */
  }
  window.location.reload()
}

export function UpdateHinweis({ children }: { children: ReactNode }) {
  const [updateBereit, setUpdateBereit] = useState(false)
  const [laeuft, setLaeuft]             = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onChange = () => {
      if (istNeuererServiceWorker(navigator.serviceWorker.controller?.scriptURL, __APP_VERSION__)) {
        setUpdateBereit(true)
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  const status = useQuery({
    queryKey:             ['system-status-bundle-drift'],
    queryFn:              () => systemApi.status(),
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

  // Platz in Knopfbreite (ab sm): Tritt der Knopf an die Stelle des Badges,
  // bricht die Navigation nicht um — mitten im Verkauf verrutscht nichts.
  return (
    <div className="flex justify-center sm:min-w-26">
      {!updateBereit && !bundleVeraltet ? children : (
        <button
          type="button"
          data-testid="update-hinweis"
          disabled={laeuft}
          onClick={() => { void aktualisieren(setLaeuft) }}
          title={`${bundleVeraltet
            ? `Version v${backendVersion} ist installiert — diese Ansicht läuft noch auf v${__APP_VERSION__}`
            : 'Neue Version verfügbar'}. Klick lädt die Kassa neu.`}
          className="flex items-center gap-1 whitespace-nowrap rounded-md bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800 transition hover:bg-blue-200 disabled:opacity-60"
        >
          <span aria-hidden="true">⟳</span>
          {laeuft ? 'Lädt…' : 'Neu laden'}
        </button>
      )}
    </div>
  )
}
