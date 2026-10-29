import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* useTransitions={false}: React Router 7 verpackt Navigationen sonst in React-Transitions (v6 tat das nicht) —
        der Wechsel Bestellseite → Ticket blieb damit hängen (E2E zy-ticketshop). */}
    <BrowserRouter useTransitions={false}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
