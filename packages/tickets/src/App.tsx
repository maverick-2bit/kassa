import { Route, Routes } from 'react-router-dom'
import { TicketSeite } from './TicketSeite'
import { CodeEingabe } from './CodeEingabe'

export function App() {
  return (
    <Routes>
      <Route path="/t/:code" element={<TicketSeite />} />
      <Route path="*" element={<CodeEingabe />} />
    </Routes>
  )
}
