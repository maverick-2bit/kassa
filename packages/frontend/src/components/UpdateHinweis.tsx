/**
 * Update-Hinweis: erscheint, wenn ein neuer Service Worker die Kontrolle
 * übernommen hat (= neue App-Version deployed). Bewusst KEIN Auto-Reload —
 * das könnte einen laufenden Verkauf unterbrechen; der Kassier entscheidet.
 */

import { useEffect, useState } from 'react'

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

  if (!updateBereit) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-xl border border-brand-300 bg-brand-50 px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium text-brand-800">Neue Version verfügbar</span>
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
