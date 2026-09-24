import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ticketCodeAusScan } from '@kassa/shared'

/** Startseite: Ticket über den Code (aus der E-Mail) wiederfinden. */
export function CodeEingabe() {
  const navigate = useNavigate()
  const [eingabe, setEingabe] = useState('')
  const [fehler,  setFehler]  = useState(false)

  function oeffnen() {
    const code = ticketCodeAusScan(eingabe)
    if (!code) { setFehler(true); return }
    navigate(`/t/${code}`)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">Ticket öffnen</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Am schnellsten über den Link in der Ticket-E-Mail. Alternativ den 16-stelligen Code eingeben.
        </p>
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); oeffnen() }}>
          <input
            value={eingabe}
            onChange={e => { setEingabe(e.target.value); setFehler(false) }}
            placeholder="z. B. axn3fc4rypdsvd59"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="block w-full rounded-lg border border-line px-3 py-2.5 font-mono text-base focus:outline-none focus:ring-2 focus:ring-kopf/30"
          />
          {fehler && <p className="text-sm text-red-600">Das ist kein gültiger Ticket-Code.</p>}
          <button type="submit" className="w-full rounded-lg bg-kopf px-4 py-2.5 font-semibold text-white">
            Ticket anzeigen
          </button>
        </form>
      </div>
    </main>
  )
}
