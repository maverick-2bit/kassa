// SW nur im Produktions-Build (Dev: Stale-Code-Falle → Alt-Registrierungen entfernen).
// Versionierte URL: neue App-Version ⇒ neuer SW ⇒ frische, versionierte Caches.
// Ohne HTTPS (http://<IP>) gibt es keinen Service Worker — die App läuft dann
// ohne Offline-Start, der Offline-Einlass selbst (IndexedDB) funktioniert trotzdem.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register(`/sw.js?v=${__APP_VERSION__}`).catch(() => { /* silent */ })
  } else {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => { void r.unregister() }))
      .catch(() => { /* silent */ })
  }
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
