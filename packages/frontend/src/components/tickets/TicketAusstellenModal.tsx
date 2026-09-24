import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  MEHRFACH_ROLLEN_VORSCHLAEGE,
  TicketAusstellenInputSchema,
  type TicketAusstellenAntwort,
  type TicketAusstellenInput,
  type TicketEventDetail,
  type TicketTyp,
} from '@kassa/shared'
import { oeffneTicketsPdf, ticketingApi } from '../../lib/api'
import { fehlerText } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Select } from '../ui/Select'

interface Props {
  event:   TicketEventDetail
  offen:   boolean
  onClose: () => void
  onFertig: () => void | Promise<void>
}

export function TicketAusstellenModal({ event, offen, onClose, onFertig }: Props) {
  const [typ,          setTyp]          = useState<TicketTyp>('einzel')
  const [artId,        setArtId]        = useState(event.arten[0]?.id ?? '')
  const [rolle,        setRolle]        = useState('Crew')
  const [anzahl,       setAnzahl]       = useState('1')
  const [name,         setName]         = useState('')
  const [geburtsdatum, setGeburtsdatum] = useState('')
  const [email,        setEmail]        = useState('')
  const [senden,       setSenden]       = useState(false)
  const [fehler,       setFehler]       = useState<string | null>(null)
  const [ergebnis,     setErgebnis]     = useState<TicketAusstellenAntwort | null>(null)

  const n = Math.max(0, Math.floor(Number(anzahl) || 0))
  const einzelnePerson = n === 1

  const ausstellen = useMutation({
    mutationFn: (input: TicketAusstellenInput) => ticketingApi.ausstellen(event.id, input),
    // onFertig wartet auf das Neuladen des Events — dann stimmt der Zähler „ausgegeben/Kontingent“ in der Auswahl sofort
    onSuccess:  async (antwort) => { setErgebnis(antwort); setFehler(null); await onFertig() },
    onError:    (err) => setFehler(fehlerText(err)),
  })

  function absenden() {
    const input: TicketAusstellenInput = {
      typ,
      anzahl: n,
      ...(typ === 'einzel' ? { ticketArtId: artId || null } : { rolle: rolle.trim() }),
      ...(einzelnePerson && name.trim() ? { name: name.trim() } : {}),
      ...(einzelnePerson && geburtsdatum ? { geburtsdatum } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(senden ? { senden: true } : {}),
    }
    const r = TicketAusstellenInputSchema.safeParse(input)
    if (!r.success) { setFehler(r.error.issues.map(i => i.message).join(' · ')); return }
    ausstellen.mutate(r.data)
  }

  /** Persönliche Angaben leeren — sonst landet beim nächsten Ticket versehentlich das Geburtsdatum der vorigen Person. */
  function personLeeren() {
    setName(''); setGeburtsdatum(''); setEmail(''); setSenden(false)
  }

  function schliessen() {
    setErgebnis(null); setFehler(null); personLeeren(); setAnzahl('1')
    onClose()
  }

  return (
    <Modal open={offen} onClose={schliessen} title="Tickets ausstellen" size="md">
      {ergebnis ? (
        <div className="space-y-4">
          <p className="text-sm text-ink">
            ✓ {ergebnis.tickets.length} {ergebnis.tickets.length === 1 ? 'Ticket' : 'Tickets'} ausgestellt.
          </p>
          {ergebnis.versand && (
            ergebnis.versand.erfolgreich
              ? <p className="text-sm text-green-700">✓ per E-Mail an {email} verschickt</p>
              : <p className="text-sm text-red-600">E-Mail nicht verschickt: {ergebnis.versand.fehler}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => void oeffneTicketsPdf(ergebnis.tickets.map(t => t.id))}>
              PDF öffnen / drucken
            </Button>
            <Button variant="secondary" onClick={() => { setErgebnis(null); personLeeren() }}>Weitere ausstellen</Button>
            <Button onClick={schliessen}>Fertig</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); absenden() }}>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['einzel',   'Einzelticket',  '1× gültig — Freikarte'],
              ['mehrfach', 'Mehrfachticket', 'beliebig oft — Crew, Feuerwehr …'],
            ] as const).map(([wert, titel, unter]) => (
              <button
                key={wert} type="button" onClick={() => setTyp(wert)}
                className={`rounded-lg border p-3 text-left ${typ === wert ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-line hover:bg-panel-2'}`}
              >
                <div className="text-sm font-semibold text-ink">{titel}</div>
                <div className="text-xs text-ink-muted">{unter}</div>
              </button>
            ))}
          </div>

          {typ === 'einzel' ? (
            event.arten.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Für dieses Event gibt es noch keine Ticketart — zuerst unter „Ticketarten“ eine anlegen.
              </p>
            ) : (
              <Field label="Ticketart" required>
                <Select value={artId} onChange={e => setArtId(e.target.value)}>
                  {event.arten.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.bezeichnung}{a.kontingent !== null ? ` (${a.ausgegeben}/${a.kontingent})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : (
            <Field label="Rolle" required hint="Steht groß auf dem Ticket und am Einlass">
              <Input value={rolle} onChange={e => setRolle(e.target.value)} maxLength={60} />
              <div className="mt-1 flex flex-wrap gap-1">
                {MEHRFACH_ROLLEN_VORSCHLAEGE.map(r => (
                  <button key={r} type="button" onClick={() => setRolle(r)}
                    className={`rounded-full border px-2 py-0.5 text-xs ${rolle === r ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line text-ink-muted hover:bg-panel-2'}`}>
                    {r}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label="Anzahl" {...(n > 1 ? { hint: 'Mehrere Tickets bleiben anonym (ohne Name/Geburtsdatum)' } : {})}>
            <Input type="number" min={1} max={200} value={anzahl} onChange={e => setAnzahl(e.target.value)} />
          </Field>

          {einzelnePerson && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" hint={event.namePflicht && typ === 'einzel' ? 'Pflicht bei diesem Event' : 'optional'}>
                <Input value={name} onChange={e => setName(e.target.value)} maxLength={200} />
              </Field>
              <Field label="Geburtsdatum" hint="bestimmt das Band — optional">
                <Input type="date" value={geburtsdatum} onChange={e => setGeburtsdatum(e.target.value)} />
              </Field>
            </div>
          )}

          <Field label="E-Mail" hint={n > 1 ? 'Alle Tickets gehen gesammelt an diese Adresse' : 'optional'}>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={senden} onChange={e => setSenden(e.target.checked)} className="h-4 w-4" disabled={!email.trim()} />
            Gleich per E-Mail verschicken
          </label>

          {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={schliessen}>Abbrechen</Button>
            <Button type="submit" loading={ausstellen.isPending} disabled={typ === 'einzel' && event.arten.length === 0}>
              {n > 1 ? `${n} Tickets ausstellen` : 'Ticket ausstellen'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
