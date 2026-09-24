import { useState } from 'react'
import {
  TICKET_EVENT_STATUS_LABELS,
  TicketEventInputSchema,
  type TicketEventDetail,
  type TicketEventInput,
  type TicketEventStatus,
} from '@kassa/shared'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { vonDatetimeLokal, zuDatetimeLokal } from '../../lib/ticketing'

interface Props {
  /** Vorhandenes Event (bearbeiten) oder undefined (neu) */
  event?:      TicketEventDetail | undefined
  /** Platzhalter fürs Veranstalter-Feld (Firmenname) */
  firmenname:  string
  speichert:   boolean
  fehler:      string | null
  onSpeichern: (input: TicketEventInput) => void
  onAbbrechen: () => void
}

export function TicketEventFormular({ event, firmenname, speichert, fehler, onSpeichern, onAbbrechen }: Props) {
  const [titel,        setTitel]        = useState(event?.titel ?? '')
  const [beginn,       setBeginn]       = useState(zuDatetimeLokal(event?.beginn))
  const [ende,         setEnde]         = useState(zuDatetimeLokal(event?.ende))
  const [ort,          setOrt]          = useState(event?.ort ?? '')
  const [adresse,      setAdresse]      = useState(event?.adresse ?? '')
  const [hinweis,      setHinweis]      = useState(event?.hinweis ?? '')
  const [veranstalter, setVeranstalter] = useState(event?.veranstalter ?? '')
  const [beschreibung, setBeschreibung] = useState(event?.beschreibung ?? '')
  const [status,       setStatus]       = useState<TicketEventStatus>(event?.status ?? 'entwurf')
  const [mindestalter, setMindestalter] = useState(event?.mindestalter?.toString() ?? '')
  const [namePflicht,  setNamePflicht]  = useState(event?.namePflicht ?? false)
  const [loeschTage,   setLoeschTage]   = useState(String(event?.datenLoeschenNachTagen ?? 30))
  const [feldFehler,   setFeldFehler]   = useState<Record<string, string>>({})

  function absenden() {
    const input: TicketEventInput = {
      titel:        titel.trim(),
      beginn:       vonDatetimeLokal(beginn) ?? '',
      ende:         vonDatetimeLokal(ende),
      ort:          ort.trim(),
      adresse:      adresse.trim() || null,
      hinweis:      hinweis.trim() || null,
      veranstalter: veranstalter.trim() || null,
      beschreibung: beschreibung.trim() || null,
      status,
      mindestalter: mindestalter.trim() === '' ? null : Number(mindestalter),
      namePflicht,
      datenLoeschenNachTagen: Number(loeschTage) || 30,
    }
    const r = TicketEventInputSchema.safeParse(input)
    if (!r.success) {
      const f: Record<string, string> = {}
      for (const i of r.error.issues) f[String(i.path[0] ?? 'allgemein')] ??= i.message
      if (!input.beginn) f['beginn'] = 'Beginn erforderlich'
      setFeldFehler(f)
      return
    }
    setFeldFehler({})
    onSpeichern(r.data)
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); absenden() }}>
      <Field label="Titel" required error={feldFehler['titel']}>
        <Input value={titel} onChange={e => setTitel(e.target.value)} placeholder="z. B. Sommerfest 2026" autoFocus />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Beginn" required error={feldFehler['beginn']}>
          <Input type="datetime-local" value={beginn} onChange={e => setBeginn(e.target.value)} />
        </Field>
        <Field label="Ende" hint="optional" error={feldFehler['ende']}>
          <Input type="datetime-local" value={ende} onChange={e => setEnde(e.target.value)} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Ort" required error={feldFehler['ort']}>
          <Input value={ort} onChange={e => setOrt(e.target.value)} placeholder="z. B. Kammersäle Leoben" />
        </Field>
        <Field label="Adresse" hint="optional">
          <Input value={adresse} onChange={e => setAdresse(e.target.value)} placeholder="Straße, Ort" />
        </Field>
      </div>

      <Field label="Hervorgehobener Hinweis" hint="Steht als goldene Pille im Ticketkopf, z. B. „Motto: …“ — optional">
        <Input value={hinweis} onChange={e => setHinweis(e.target.value)} maxLength={200} placeholder="z. B. Motto: wird am Abend enthüllt" />
      </Field>

      <Field label="Veranstalter" hint={`Leer = ${firmenname}`}>
        <Input value={veranstalter} onChange={e => setVeranstalter(e.target.value)} placeholder={firmenname} />
      </Field>

      <Field label="Beschreibung" hint="Für den Ticketshop — optional">
        <textarea
          value={beschreibung} onChange={e => setBeschreibung(e.target.value)} rows={3}
          className="block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status">
          <Select value={status} onChange={e => setStatus(e.target.value as TicketEventStatus)}>
            {(Object.keys(TICKET_EVENT_STATUS_LABELS) as TicketEventStatus[]).map(s => (
              <option key={s} value={s}>{TICKET_EVENT_STATUS_LABELS[s]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Mindestalter" hint="am Eventtag, leer = keins" error={feldFehler['mindestalter']}>
          <Input type="number" min={0} max={99} value={mindestalter} onChange={e => setMindestalter(e.target.value)} />
        </Field>
        <Field label="Geburtsdaten löschen" hint="Tage nach dem Event">
          <Input type="number" min={1} max={365} value={loeschTage} onChange={e => setLoeschTage(e.target.value)} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={namePflicht} onChange={e => setNamePflicht(e.target.checked)} className="h-4 w-4" />
        Name je Ticket ist Pflicht (personalisierte Tickets)
      </label>

      {status === 'test' && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          „Interner Test“: Tickets tragen den Vermerk „Interner Test · nicht veröffentlichen“ und das Event erscheint nicht im Shop.
        </p>
      )}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichert}>{event ? 'Speichern' : 'Event anlegen'}</Button>
      </div>
    </form>
  )
}
