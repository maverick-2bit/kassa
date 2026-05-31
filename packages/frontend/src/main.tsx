import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { offlineManager } from './lib/offline'
import './index.css'

// Service Worker + Offline-Manager initialisieren
offlineManager.init().catch(console.warn)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
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
