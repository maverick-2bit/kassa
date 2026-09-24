import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  STANDARD_BAENDER,
  TicketBaenderSetzenSchema,
  bandAltersText,
  type TicketBandInput,
  type TicketEventDetail,
} from '@kassa/shared'
import { ticketingApi } from '../../lib/api'
import { fehlerText } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

interface Zeile {
  bezeichnung: string
  farbe:       string
  alterVon:    string
  alterBis:    string
  hinweis:     string
}

const zuZeile = (b: { bezeichnung: string; farbe: string; alterVon: number | null; alterBis: number | null; hinweis?: string | null | undefined }): Zeile => ({
  bezeichnung: b.bezeichnung, farbe: b.farbe,
  alterVon: b.alterVon?.toString() ?? '', alterBis: b.alterBis?.toString() ?? '', hinweis: b.hinweis ?? '',
})

const zuInput = (z: Zeile, i: number): TicketBandInput => ({
  bezeichnung: z.bezeichnung.trim(), farbe: z.farbe,
  alterVon: z.alterVon.trim() === '' ? null : Number(z.alterVon),
  alterBis: z.alterBis.trim() === '' ? null : Number(z.alterBis),
  hinweis:  z.hinweis.trim() || null,
  reihenfolge: i,
})

export function BaenderEditor({ event }: { event: TicketEventDetail }) {
  const qc = useQueryClient()
  const [zeilen,   setZeilen]   = useState<Zeile[]>(() => event.baender.map(zuZeile))
  const [fehler,   setFehler]   = useState<string | null>(null)
  const [geaendert, setGeaendert] = useState(false)
  const [ok,       setOk]       = useState(false)

  // Serverstand übernehmen, solange hier nichts ungespeichert ist
  useEffect(() => { if (!geaendert) setZeilen(event.baender.map(zuZeile)) }, [event.baender, geaendert])

  const speichern = useMutation({
    mutationFn: () => ticketingApi.setzeBaender(event.id, { baender: zeilen.map(zuInput) }),
    onSuccess:  () => {
      setGeaendert(false); setFehler(null); setOk(true); setTimeout(() => setOk(false), 2500)
      qc.invalidateQueries({ queryKey: ['ticket-event', event.id] })
      qc.invalidateQueries({ queryKey: ['ticket-liste', event.id] })
    },
    onError: (err) => setFehler(fehlerText(err)),
  })

  function aendere(i: number, feld: keyof Zeile, wert: string) {
    setZeilen(z => z.map((zeile, j) => j === i ? { ...zeile, [feld]: wert } : zeile))
    setGeaendert(true)
  }

  function pruefenUndSpeichern() {
    const r = TicketBaenderSetzenSchema.safeParse({ baender: zeilen.map(zuInput) })
    if (!r.success) { setFehler(r.error.issues.map(i => i.message).join(' · ')); return }
    speichern.mutate()
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Welches Band ein Gast am Einlass bekommt — entscheidend ist sein Alter <strong>am Eventtag</strong>.
        Grenzen sind inklusiv; leer = offen. Die Altersbereiche dürfen sich nicht überschneiden.
      </p>

      <div className="space-y-2">
        {zeilen.map((z, i) => {
          const vorschau = zuInput(z, i)
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3">
              <input type="color" value={z.farbe} onChange={e => aendere(i, 'farbe', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-line-strong bg-panel" aria-label="Farbe" />
              <div className="w-28"><Input value={z.bezeichnung} onChange={e => aendere(i, 'bezeichnung', e.target.value)} placeholder="Name" /></div>
              <div className="flex items-center gap-1 text-xs text-ink-muted">
                <span>Alter</span>
                <div className="w-16"><Input type="number" min={0} max={120} value={z.alterVon} onChange={e => aendere(i, 'alterVon', e.target.value)} placeholder="von" /></div>
                <span>–</span>
                <div className="w-16"><Input type="number" min={0} max={120} value={z.alterBis} onChange={e => aendere(i, 'alterBis', e.target.value)} placeholder="bis" /></div>
              </div>
              <div className="min-w-[10rem] flex-1"><Input value={z.hinweis} onChange={e => aendere(i, 'hinweis', e.target.value)} placeholder="Hinweis fürs Einlasspersonal" /></div>
              <span className="rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: z.farbe }}>
                Band {z.bezeichnung || '…'} · {bandAltersText(vorschau)}
              </span>
              <button type="button" onClick={() => { setZeilen(zs => zs.filter((_, j) => j !== i)); setGeaendert(true) }}
                className="text-ink-subtle hover:text-red-600" aria-label="Band entfernen">✕</button>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={zeilen.length >= 10}
          onClick={() => { setZeilen(z => [...z, { bezeichnung: '', farbe: '#2563eb', alterVon: '', alterBis: '', hinweis: '' }]); setGeaendert(true) }}>
          + Band
        </Button>
        <Button size="sm" variant="secondary"
          onClick={() => { setZeilen(STANDARD_BAENDER.map(zuZeile)); setGeaendert(true) }}>
          Standard (Jugendschutz) laden
        </Button>
        <div className="flex-1" />
        {ok && <span className="text-xs text-green-700">✓ gespeichert</span>}
        <Button size="sm" loading={speichern.isPending} disabled={!geaendert} onClick={pruefenUndSpeichern}>Bänder speichern</Button>
      </div>
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
    </div>
  )
}
