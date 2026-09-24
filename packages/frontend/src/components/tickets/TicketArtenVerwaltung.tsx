import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MWST_LABELS,
  TicketArtInputSchema,
  type MwStSatz,
  type TicketArt,
  type TicketArtInput,
  type TicketEventDetail,
} from '@kassa/shared'
import { ticketingApi } from '../../lib/api'
import { formatPreis, parseEuroToCent } from '../../lib/format'
import { fehlerText, vonDatetimeLokal, zuDatetimeLokal } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Select } from '../ui/Select'

export function TicketArtenVerwaltung({ event }: { event: TicketEventDetail }) {
  const qc = useQueryClient()
  const [bearbeite, setBearbeite] = useState<TicketArt | 'neu' | null>(null)
  const [meldung,   setMeldung]   = useState<string | null>(null)

  const aktualisieren = () => {
    qc.invalidateQueries({ queryKey: ['ticket-event', event.id] })
    qc.invalidateQueries({ queryKey: ['ticket-events'] })
  }
  const loeschen = useMutation({
    mutationFn: ticketingApi.loescheArt,
    onSuccess:  aktualisieren,
    onError:    (err) => setMeldung(fehlerText(err)),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">Was es für dieses Event zu kaufen gibt — Preis, Kontingent, Verkaufszeitraum.</p>
        <Button size="sm" onClick={() => setBearbeite('neu')}>+ Ticketart</Button>
      </div>
      {meldung && <p className="text-sm text-red-600">{meldung}</p>}

      {event.arten.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong py-10 text-center text-sm text-ink-muted">
          Noch keine Ticketart angelegt.
        </div>
      ) : event.arten.map(a => (
        <div key={a.id} className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{a.bezeichnung}</span>
                {!a.onlineVerkauf && (
                  <span className="rounded-full border border-line-strong bg-panel-2 px-2 py-0.5 text-[11px] text-ink-muted">nur intern</span>
                )}
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">
                {a.preisCent === 0 ? 'kostenlos' : formatPreis(a.preisCent)} · {MWST_LABELS[a.mwstSatz]} · max. {a.maxProBestellung} je Bestellung
              </p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-2">
                  <div className="h-full bg-brand-500"
                    style={{ width: a.kontingent ? `${Math.min(100, (a.ausgegeben / a.kontingent) * 100)}%` : '0%' }} />
                </div>
                <span className="text-xs text-ink-muted tabular-nums">
                  {a.ausgegeben} ausgegeben{a.kontingent !== null ? ` von ${a.kontingent}` : ' · unbegrenzt'}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 gap-3 text-xs font-medium">
              <button type="button" className="text-brand-600 hover:underline" onClick={() => setBearbeite(a)}>Bearbeiten</button>
              <button type="button" className="text-red-600 hover:underline"
                onClick={() => { if (window.confirm(`Ticketart „${a.bezeichnung}“ löschen?`)) loeschen.mutate(a.id) }}>
                Löschen
              </button>
            </div>
          </div>
        </div>
      ))}

      <Modal open={bearbeite !== null} onClose={() => setBearbeite(null)} title={bearbeite === 'neu' ? 'Neue Ticketart' : 'Ticketart bearbeiten'}>
        {bearbeite !== null && (
          <TicketArtFormular
            eventId={event.id}
            art={bearbeite === 'neu' ? undefined : bearbeite}
            onFertig={() => { setBearbeite(null); aktualisieren() }}
            onAbbrechen={() => setBearbeite(null)}
          />
        )}
      </Modal>
    </div>
  )
}

function TicketArtFormular({ eventId, art, onFertig, onAbbrechen }: {
  eventId: string; art?: TicketArt | undefined; onFertig: () => void; onAbbrechen: () => void
}) {
  const [bezeichnung,  setBezeichnung]  = useState(art?.bezeichnung ?? '')
  const [beschreibung, setBeschreibung] = useState(art?.beschreibung ?? '')
  const [preis,        setPreis]        = useState(art ? (art.preisCent / 100).toFixed(2).replace('.', ',') : '')
  const [mwst,         setMwst]         = useState<MwStSatz>(art?.mwstSatz ?? 'ermaessigt1')
  const [kontingent,   setKontingent]   = useState(art?.kontingent?.toString() ?? '')
  const [maxBestellung, setMaxBestellung] = useState(String(art?.maxProBestellung ?? 10))
  const [verkaufAb,    setVerkaufAb]    = useState(zuDatetimeLokal(art?.verkaufAb))
  const [verkaufBis,   setVerkaufBis]   = useState(zuDatetimeLokal(art?.verkaufBis))
  const [online,       setOnline]       = useState(art?.onlineVerkauf ?? true)
  const [fehler,       setFehler]       = useState<string | null>(null)

  const speichern = useMutation({
    mutationFn: (input: TicketArtInput) => art ? ticketingApi.aendereArt(art.id, input) : ticketingApi.erstelleArt(eventId, input),
    onSuccess:  onFertig,
    onError:    (err) => setFehler(fehlerText(err)),
  })

  function absenden() {
    const preisCent = preis.trim() === '' ? 0 : parseEuroToCent(preis)
    if (preisCent === null || preisCent < 0) { setFehler('Preis ungültig'); return }
    const input: TicketArtInput = {
      bezeichnung:      bezeichnung.trim(),
      beschreibung:     beschreibung.trim() || null,
      preisCent,
      mwstSatz:         mwst,
      kontingent:       kontingent.trim() === '' ? null : Number(kontingent),
      maxProBestellung: Number(maxBestellung) || 10,
      verkaufAb:        vonDatetimeLokal(verkaufAb),
      verkaufBis:       vonDatetimeLokal(verkaufBis),
      onlineVerkauf:    online,
    }
    const r = TicketArtInputSchema.safeParse(input)
    if (!r.success) { setFehler(r.error.issues.map(i => i.message).join(' · ')); return }
    speichern.mutate(r.data)
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); absenden() }}>
      <Field label="Bezeichnung" required hint="Steht so auf dem Ticket, z. B. „Buffet“ oder „Stehplatz“">
        <Input value={bezeichnung} onChange={e => setBezeichnung(e.target.value)} autoFocus maxLength={120} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Preis (€)" hint="0 = kostenlos">
          <Input inputMode="decimal" value={preis} onChange={e => setPreis(e.target.value)} placeholder="0,00" />
        </Field>
        <Field label="MwSt">
          <Select value={mwst} onChange={e => setMwst(e.target.value as MwStSatz)}>
            {(Object.keys(MWST_LABELS) as MwStSatz[]).map(k => <option key={k} value={k}>{MWST_LABELS[k]}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kontingent" hint="leer = unbegrenzt">
          <Input type="number" min={0} value={kontingent} onChange={e => setKontingent(e.target.value)} />
        </Field>
        <Field label="Max. je Bestellung">
          <Input type="number" min={1} max={50} value={maxBestellung} onChange={e => setMaxBestellung(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Verkauf ab" hint="optional">
          <Input type="datetime-local" value={verkaufAb} onChange={e => setVerkaufAb(e.target.value)} />
        </Field>
        <Field label="Verkauf bis" hint="optional">
          <Input type="datetime-local" value={verkaufBis} onChange={e => setVerkaufBis(e.target.value)} />
        </Field>
      </div>
      <Field label="Beschreibung" hint="Für den Ticketshop — optional">
        <Input value={beschreibung} onChange={e => setBeschreibung(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={online} onChange={e => setOnline(e.target.checked)} className="h-4 w-4" />
        Im Online-Shop verkaufen (aus = nur intern ausstellbar, z. B. Freikarten)
      </label>
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichern.isPending}>Speichern</Button>
      </div>
    </form>
  )
}
