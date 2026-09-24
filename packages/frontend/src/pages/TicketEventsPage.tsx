import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TICKET_EVENT_STATUS_LABELS } from '@kassa/shared'
import { ticketingApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { useServerHost } from '../lib/serverHost'
import { EVENT_STATUS_STIL, TICKET_APP_PORT, fehlerText, formatEventDatum } from '../lib/ticketing'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { TicketEventFormular } from '../components/tickets/TicketEventFormular'

export function TicketEventsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const firmenname = getAuth()?.mandant.firmenname ?? ''
  const [neuOffen, setNeuOffen] = useState(false)
  const [fehler,   setFehler]   = useState<string | null>(null)

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['ticket-events'],
    queryFn:  ticketingApi.events,
  })

  const erstellen = useMutation({
    mutationFn: ticketingApi.erstelleEvent,
    onSuccess:  (e) => {
      qc.invalidateQueries({ queryKey: ['ticket-events'] })
      setNeuOffen(false)
      navigate(`/tickets/${e.id}`)
    },
    onError: (err) => setFehler(fehlerText(err)),
  })

  const jetzt = Date.now()
  const kommend  = events.filter(e => new Date(e.ende ?? e.beginn).getTime() >= jetzt - 12 * 3600_000)
  const vergangen = events.filter(e => !kommend.includes(e))

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Events & Tickets</h1>
          <p className="text-sm text-ink-muted mt-0.5">Events anlegen, Tickets ausstellen und verschicken</p>
        </div>
        <Button onClick={() => { setNeuOffen(true); setFehler(null) }}>+ Neues Event</Button>
      </div>

      <TicketAdresseKarte />

      {isLoading ? (
        <p className="text-sm text-ink-muted">Lädt…</p>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong py-16 text-center">
          <p className="text-ink-muted">Noch keine Events angelegt.</p>
          <p className="text-sm text-ink-subtle mt-1">Klicke auf «+ Neues Event».</p>
        </div>
      ) : (
        <>
          <EventListe titel="Kommende Events" events={kommend} />
          {vergangen.length > 0 && <EventListe titel="Vergangen" events={vergangen} gedimmt />}
        </>
      )}

      <Modal open={neuOffen} onClose={() => setNeuOffen(false)} title="Neues Event" size="lg">
        <TicketEventFormular
          firmenname={firmenname}
          speichert={erstellen.isPending}
          fehler={fehler}
          onSpeichern={(input) => erstellen.mutate(input)}
          onAbbrechen={() => setNeuOffen(false)}
        />
      </Modal>
    </div>
  )
}

function EventListe({ titel, events, gedimmt }: {
  titel: string
  events: Awaited<ReturnType<typeof ticketingApi.events>>
  gedimmt?: boolean
}) {
  const navigate = useNavigate()
  if (events.length === 0) return null
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{titel}</h2>
      <div className={`space-y-2 ${gedimmt ? 'opacity-70' : ''}`}>
        {events.map(e => (
          <button
            key={e.id} type="button" onClick={() => navigate(`/tickets/${e.id}`)}
            className="flex w-full items-center gap-4 rounded-xl border border-line bg-panel p-4 text-left hover:border-brand-300 hover:bg-panel-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{e.titel}</span>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${EVENT_STATUS_STIL[e.status]}`}>
                  {TICKET_EVENT_STATUS_LABELS[e.status]}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">{formatEventDatum(e.beginn)} · {e.ort}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-bold text-ink tabular-nums">{e.besucher} <span className="text-sm font-normal text-ink-muted">/ {e.tickets}</span></p>
              <p className="text-[11px] text-ink-subtle">Besucher / Tickets</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * Ticket-Adresse: Basis für Links und QR-Codes in den Ticket-E-Mails. Ohne sie
 * zeigen die Mails auf nichts — deshalb prominent und mit Vorschlag.
 */
function TicketAdresseKarte() {
  const qc = useQueryClient()
  const { host } = useServerHost()
  const { data } = useQuery({ queryKey: ['ticket-einstellungen'], queryFn: ticketingApi.einstellungen })
  const [wert,   setWert]   = useState('')
  const [fehler, setFehler] = useState<string | null>(null)
  const [ok,     setOk]     = useState(false)

  useEffect(() => { if (data) setWert(data.ticketBasisUrl ?? '') }, [data])

  const speichern = useMutation({
    mutationFn: () => ticketingApi.setzeEinstellungen(wert.trim() || null),
    onSuccess:  (d) => {
      qc.setQueryData(['ticket-einstellungen'], d)
      setFehler(null); setOk(true); setTimeout(() => setOk(false), 2500)
    },
    onError: (err) => setFehler(fehlerText(err)),
  })

  const vorschlag = host ? `http://${host}:${TICKET_APP_PORT}` : null
  const fehlt = data && !data.ticketBasisUrl

  return (
    <section className={`rounded-xl border p-4 ${fehlt ? 'border-amber-200 bg-amber-50' : 'border-line bg-panel'}`}>
      <h2 className="text-sm font-semibold text-ink">Ticket-Adresse</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Unter dieser Adresse öffnen Gäste ihr Ticket — Link und QR-Code in der E-Mail zeigen dorthin.
        Für den Online-Verkauf eine öffentliche Adresse mit HTTPS (z. B. <code>https://tickets.deinefirma.at</code>).
      </p>
      {fehlt && (
        <p className="mt-2 text-xs font-medium text-amber-800">
          Noch nicht eingerichtet — ohne Adresse können keine Tickets per E-Mail verschickt werden.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[16rem] flex-1">
          <Input value={wert} onChange={e => setWert(e.target.value)} placeholder="https://tickets.deinefirma.at" />
        </div>
        <Button size="sm" loading={speichern.isPending} onClick={() => speichern.mutate()}>Speichern</Button>
        {vorschlag && wert !== vorschlag && (
          <button type="button" onClick={() => setWert(vorschlag)} className="text-xs text-brand-600 hover:underline">
            Im lokalen Netz: {vorschlag}
          </button>
        )}
        {ok && <span className="text-xs text-green-700">✓ gespeichert</span>}
      </div>
      {fehler && <p className="mt-2 text-xs text-red-600">{fehler}</p>}
    </section>
  )
}
