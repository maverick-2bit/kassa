// SW nur im Produktions-Build (Dev: Stale-Code-Falle → Alt-Registrierungen entfernen).
// Versionierte URL: neue App-Version ⇒ neuer SW ⇒ frische, versionierte Caches.
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { App } from './App'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
