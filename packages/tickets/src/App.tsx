import { Route, Routes } from 'react-router-dom'
import { TicketSeite } from './TicketSeite'
import { CodeEingabe } from './CodeEingabe'
import { EventShop } from './shop/EventShop'
import { BestellSeite } from './shop/BestellSeite'
import { Veranstalter } from './shop/Veranstalter'

export function App() {
  return (
    <Routes>
      <Route path="/t/:code" element={<TicketSeite />} />
      <Route path="/e/:eventId" element={<EventShop />} />
      <Route path="/b/:bestellungId" element={<BestellSeite />} />
      <Route path="/v/:mandantId" element={<Veranstalter />} />
      <Route path="*" element={<CodeEingabe />} />
    </Routes>
  )
}
