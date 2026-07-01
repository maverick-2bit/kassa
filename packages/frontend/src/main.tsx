import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { offlineManager } from './lib/offline'
import { initTheme } from './lib/theme'
import '@fontsource-variable/inter'
import './index.css'

// Theme (hell/dunkel) vor dem ersten Render setzen — kein Hell-Blitz
initTheme()

// Service Worker + Offline-Manager initialisieren
offlineManager.init().catch(console.warn)

const queryClient = new QueryClient({
  defaultOptions: {
    // refetchOnWindowFocus: neue Einträge (auch aus anderen Fenstern/Tabs)
    // erscheinen automatisch, sobald man zum Fenster zurückkehrt — ohne Reload.
    queries: { retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('Root-Element nicht gefunden')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
