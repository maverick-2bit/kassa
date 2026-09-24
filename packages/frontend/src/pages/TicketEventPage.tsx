import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { TICKET_EVENT_STATUS_LABELS, type TicketEinlassStand, type TicketEventDetail, type TicketEventStatus } from '@kassa/shared'
import { ticketingApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { EVENT_STATUS_STIL, fehlerText, formatEventDatum } from '../lib/ticketing'
import { Button } from '../components/ui/Button'
import { TicketEventFormular } from '../components/tickets/TicketEventFormular'
import { TicketListe } from '../components/tickets/TicketListe'
import { TicketArtenVerwaltung } from '../components/tickets/TicketArtenVerwaltung'
import { BaenderEditor } from '../components/tickets/BaenderEditor'
import { EinlassProtokoll } from '../components/tickets/EinlassProtokoll'
import { TicketBestellungen } from '../components/tickets/TicketBestellungen'
import { Modal } from '../components/ui/Modal'

type Reiter = 'tickets' | 'bestellungen' | 'einlass' | 'arten' | 'baender' | 'event'

const REITER: Array<[Reiter, string]> = [
  ['tickets', 'Tickets'],
  ['bestellungen', 'Bestellungen'],
  ['einlass', 'Einlass'],
  ['arten',   'Ticketarten'],
  ['baender', 'Bänder'],
  ['event',   'Event'],
]

export function TicketEventPage() {
  const { eventId = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const firmenname = getAuth()?.mandant.firmenname ?? ''
  const [reiter, setReiter] = useState<Reiter>('tickets')
  const [fehler, setFehler] = useState<string | null>(null)

  // Alle 10 s neu laden — die Besucherzahl soll während des Einlasses mitlaufen
  const { data: event, isLoading, error } = useQuery({
    queryKey: ['ticket-event', eventId],
    queryFn:  () => ticketingApi.event(eventId),
    refetchInterval: 10_000,
  })

  const aendern = useMutation({
    mutationFn: (input: Parameters<typeof ticketingApi.aendereEvent>[1]) => ticketingApi.aendereEvent(eventId, input),
    onSuccess:  (e) => {
      qc.setQueryData(['ticket-event', eventId], e)
      qc.invalidateQueries({ queryKey: ['ticket-events'] })
      qc.invalidateQueries({ queryKey: ['ticket-liste', eventId] })
      setFehler(null); setReiter('tickets')
    },
    onError: (err) => setFehler(fehlerText(err)),
  })

  const loeschen = useMutation({
    mutationFn: () => ticketingApi.loescheEvent(eventId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['ticket-events'] }); navigate('/tickets') },
    onError:    (err) => setFehler(fehlerText(err)),
  })

  if (isLoading) return <div className="p-6 text-sm text-ink-muted">Lädt…</div>
  if (error || !event) {
    return (
      <div className="p-6 text-sm">
        <p className="text-red-600">{error ? fehlerText(error) : 'Event nicht gefunden'}</p>
        <Link to="/tickets" className="text-brand-600 hover:underline">← zur Übersicht</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-5">
      <div>
        <Link to="/tickets" className="text-xs text-brand-600 hover:underline">← Alle Events</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-ink">{event.titel}</h1>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${EVENT_STATUS_STIL[event.status]}`}>
            {TICKET_EVENT_STATUS_LABELS[event.status]}
          </span>
        </div>
        <p className="text-sm text-ink-muted">
          {formatEventDatum(event.beginn)} · {event.ort}
          {event.mindestalter !== null && <> · ab {event.mindestalter} Jahren</>}
        </p>
      </div>

      <EinlassKacheln stand={event.stand} />
      <ShopLink eventId={event.id} status={event.status} />

      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {REITER.map(([id, titel]) => (
          <button
            key={id} type="button" onClick={() => setReiter(id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${reiter === id ? 'border-brand-500 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink'}`}
          >
            {titel}
          </button>
        ))}
      </div>

      {reiter === 'tickets' && <TicketListe event={event} />}
      {reiter === 'bestellungen' && <TicketBestellungen event={event} />}
      {reiter === 'einlass' && <EinlassProtokoll event={event} />}
      {reiter === 'arten'   && <TicketArtenVerwaltung event={event} />}
      {reiter === 'baender' && <BaenderEditor event={event} />}
      {reiter === 'event' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-line bg-panel p-5">
            <TicketEventFormular
              key={event.id}
              event={event}
              firmenname={firmenname}
              speichert={aendern.isPending}
              fehler={fehler}
              onSpeichern={(input) => aendern.mutate(input)}
              onAbbrechen={() => setReiter('tickets')}
            />
          </div>
          <DatenschutzKarte event={event} />
          <div className="rounded-xl border border-red-200 bg-red-50/50 p-4">
            <p className="text-sm font-medium text-ink">Event löschen</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Nur möglich, solange es keine Tickets gibt. Mit Tickets den Status auf „Abgesagt“ setzen — die Tickets gelten dann nicht mehr.
            </p>
            <Button size="sm" variant="danger" className="mt-3" loading={loeschen.isPending}
              onClick={() => { if (window.confirm(`Event „${event.titel}“ endgültig löschen?`)) loeschen.mutate() }}>
              Event löschen
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const DATUM = new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })

/**
 * DSGVO: Personendaten (Namen, Geburtsdaten, E-Mails) werden X Tage nach dem
 * Event automatisch gelöscht; „Jetzt löschen" geht erst nach dem Event — bis
 * dahin braucht der Einlass die Geburtsdaten fürs Band.
 */
function DatenschutzKarte({ event }: { event: TicketEventDetail }) {
  const qc = useQueryClient()
  const [meldung, setMeldung] = useState<string | null>(null)
  const ende     = new Date(event.ende ?? event.beginn)
  const loeschAm = new Date(ende.getTime() + event.datenLoeschenNachTagen * 86_400_000)
  const vorbei   = Date.now() > ende.getTime()

  const loeschen = useMutation({
    mutationFn: () => ticketingApi.personendatenLoeschen(event.id),
    onSuccess:  (r) => {
      setMeldung(`Gelöscht: Personendaten an ${r.tickets} Tickets und ${r.bestellungen} Bestellungen.`)
      void qc.invalidateQueries({ queryKey: ['ticket-event', event.id] })
      void qc.invalidateQueries({ queryKey: ['ticket-liste', event.id] })
    },
    onError: (err) => setMeldung(fehlerText(err)),
  })

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="text-sm font-medium text-ink">Datenschutz</p>
      {event.datenGeloeschtAt ? (
        <p className="mt-0.5 text-xs text-ink-muted">
          Namen, Geburtsdaten und E-Mail-Adressen wurden am {DATUM.format(new Date(event.datenGeloeschtAt))} gelöscht.
          Tickets, Beträge und Einlasszeiten bleiben für die Auswertung.
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-ink-muted">
            Namen, Geburtsdaten und E-Mail-Adressen von Gästen und Käufern werden am <strong>{DATUM.format(loeschAm)}</strong>{' '}
            automatisch gelöscht ({event.datenLoeschenNachTagen} Tage nach dem Event, im Formular oben einstellbar).
            Tickets, Beträge und Einlasszeiten bleiben.
          </p>
          <Button size="sm" variant="secondary" className="mt-3" disabled={!vorbei} loading={loeschen.isPending}
            onClick={() => { if (window.confirm('Personendaten dieses Events jetzt endgültig löschen?')) loeschen.mutate() }}>
            Jetzt löschen
          </Button>
          {!vorbei && <p className="mt-1 text-[11px] text-ink-subtle">Erst nach dem Event möglich — bis dahin braucht der Einlass die Geburtsdaten.</p>}
        </>
      )}
      {meldung && <p className="mt-2 text-xs text-ink">{meldung}</p>}
    </div>
  )
}

/** Link zum Verkauf dieses Events — zum Teilen und als QR für Plakat/Flyer. */
function ShopLink({ eventId, status }: { eventId: string; status: TicketEventStatus }) {
  const { data } = useQuery({ queryKey: ['ticket-einstellungen'], queryFn: ticketingApi.einstellungen })
  const [qrOffen, setQrOffen] = useState(false)
  const [kopiert, setKopiert] = useState(false)
  if (!data) return null

  if (status === 'entwurf' || status === 'abgesagt') {
    return (
      <p className="rounded-xl border border-line bg-panel px-4 py-2.5 text-xs text-ink-muted">
        Online-Verkauf: {status === 'abgesagt'
          ? 'abgesagt — der Shop verkauft nichts mehr.'
          : 'im Shop sichtbar, sobald der Status „Veröffentlicht“ ist (zum Ausprobieren: „Test“).'}
      </p>
    )
  }
  if (!data.ticketBasisUrl) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
        Online-Verkauf: Ticket-Adresse fehlt — unter „Alle Events“ → Adressen eintragen.
      </p>
    )
  }
  const url = `${data.ticketBasisUrl}/e/${eventId}`
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-2.5 text-xs">
      <span className="font-medium text-ink">Online-Verkauf{status === 'test' ? ' (Test — nur über diesen Link)' : ''}:</span>
      <a href={url} target="_blank" rel="noreferrer" className="font-mono text-brand-600 hover:underline">{url}</a>
      <button type="button" className="text-brand-600 hover:underline"
        onClick={() => { void navigator.clipboard?.writeText(url); setKopiert(true); setTimeout(() => setKopiert(false), 2000) }}>
        {kopiert ? '✓ kopiert' : 'kopieren'}
      </button>
      <button type="button" className="text-brand-600 hover:underline" onClick={() => setQrOffen(true)}>QR-Code</button>
      <Modal open={qrOffen} onClose={() => setQrOffen(false)} title="QR-Code zum Ticketkauf" size="sm">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg bg-white p-4"><QRCodeSVG value={url} size={240} level="M" /></div>
          <p className="break-all text-center font-mono text-xs text-ink-muted">{url}</p>
        </div>
      </Modal>
    </div>
  )
}

/**
 * Besucherzahl immer sichtbar. Mehrfachtickets zählen genau einmal (erster
 * Einlass) — die Crew läuft sonst den Zähler hoch, jedes Mal wenn sie rein und raus geht.
 */
function EinlassKacheln({ stand }: { stand: TicketEinlassStand }) {
  const baender = stand.proBand.filter(b => b.anzahl > 0 || b.bandId !== null)
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-brand-700">Besucher jetzt</p>
        <p className="mt-1 text-3xl font-bold text-brand-800 tabular-nums">{stand.besucher}</p>
        <p className="text-xs text-brand-700">
          davon {stand.besucherMehrfach} Mehrfachticket{stand.besucherMehrfach === 1 ? '' : 's'} (je einmal gezählt)
        </p>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Gültige Tickets</p>
        <p className="mt-1 text-3xl font-bold text-ink tabular-nums">{stand.tickets}</p>
        <p className="text-xs text-ink-muted">davon {stand.mehrfach} Mehrfach · noch {Math.max(0, stand.tickets - stand.besucher)} nicht eingelassen</p>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Bänder ausgegeben</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {baender.length === 0 && <span className="text-sm text-ink-subtle">—</span>}
          {baender.map(b => (
            <span key={b.bandId ?? 'ohne'} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.farbe ?? '#9ca3af' }} />
              {b.bezeichnung} <strong className="tabular-nums">{b.anzahl}</strong>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
