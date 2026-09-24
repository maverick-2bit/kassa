import { useCallback, useEffect, useRef, useState } from 'react'
import type { EinlassEvent, EinlassIch, TicketEinlassStand } from '@kassa/shared'
import { KeineVerbindung, NichtAngemeldet, einlassApi } from './lib/api'
import { freischalten, signal } from './lib/feedback'
import { Kamera } from './Kamera'
import { Ergebnis, type Anzeige } from './Ergebnis'

/** So lange bleibt das Ergebnis stehen, wenn niemand tippt. */
const ANZEIGE_MS = 3000
/**
 * Derselbe QR wird so lange ignoriert: nach dem Einlass hält der Gast sein
 * Handy oft noch vor die Kamera — ohne Sperre käme sofort ein rotes
 * „bereits eingelöst" hinterher, obwohl alles in Ordnung ist.
 */
const GLEICHER_CODE_SPERRE_MS = 6000

const istTouch = () => window.matchMedia('(pointer: coarse)').matches

export function Scanner({ ich, event, onEventWechseln, onAbgemeldet }: {
  ich: EinlassIch
  event: EinlassEvent
  onEventWechseln: () => void
  onAbgemeldet: (hinweis: string) => void
}) {
  const [stand, setStand]       = useState<TicketEinlassStand | null>(null)
  const [anzeige, setAnzeige]   = useState<Anzeige | null>(null)
  const [pruefe, setPruefe]     = useState(false)
  const [eingabe, setEingabe]   = useState('')
  const [online, setOnline]     = useState(true)
  const [kamera, setKamera]     = useState(false)
  const eingabeFeld = useRef<HTMLInputElement>(null)
  const beschaeftigt = useRef(false)
  const letzter = useRef<{ inhalt: string; zeit: number } | null>(null)
  const ausblenden = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Besucherzahl immer aktuell: nach jedem Scan aus der Antwort, dazu alle 10 s
  // (andere Eingänge scannen parallel)
  const standLaden = useCallback(async () => {
    try {
      setStand(await einlassApi.stand(event.id))
      setOnline(true)
    } catch (err) {
      if (err instanceof NichtAngemeldet) onAbgemeldet(err.message)
      else if (err instanceof KeineVerbindung) setOnline(false)
    }
  }, [event.id, onAbgemeldet])

  useEffect(() => {
    void standLaden()
    const t = setInterval(() => void standLaden(), 10_000)
    return () => clearInterval(t)
  }, [standLaden])

  const weiter = useCallback(() => {
    if (ausblenden.current) clearTimeout(ausblenden.current)
    setAnzeige(null)
    beschaeftigt.current = false
    if (!istTouch()) eingabeFeld.current?.focus()   // Handscanner tippt ins Feld
  }, [])

  const zeige = useCallback((a: Anzeige) => {
    setAnzeige(a)
    if (ausblenden.current) clearTimeout(ausblenden.current)
    ausblenden.current = setTimeout(weiter, ANZEIGE_MS)
  }, [weiter])

  /**
   * `quelle`: Die Sperre für denselben Code gilt nur für die Kamera — sie liest
   * einen hingehaltenen QR mehrmals pro Sekunde. Wer bewusst tippt oder den
   * Handscanner auslöst, bekommt immer ein Ergebnis (auch „bereits eingelöst").
   */
  const pruefen = useCallback(async (inhalt: string, quelle: 'kamera' | 'eingabe') => {
    const text = inhalt.trim()
    if (!text || beschaeftigt.current) return
    const jetzt = Date.now()
    if (quelle === 'kamera' && letzter.current && letzter.current.inhalt === text
        && jetzt - letzter.current.zeit < GLEICHER_CODE_SPERRE_MS) return
    letzter.current = { inhalt: text, zeit: jetzt }
    beschaeftigt.current = true
    setPruefe(true)
    try {
      const ergebnis = await einlassApi.scan(event.id, text)
      setStand(ergebnis.stand)
      setOnline(true)
      signal(ergebnis.ergebnis === 'zugelassen' ? 'ok' : ergebnis.ergebnis === 'mehrfach' ? 'mehrfach' : 'nein')
      zeige({ art: 'ergebnis', ergebnis })
    } catch (err) {
      if (err instanceof NichtAngemeldet) { onAbgemeldet(err.message); return }
      // Nicht geprüft = nicht eingelöst: derselbe Code darf sofort erneut versucht werden
      letzter.current = null
      signal('nein')
      if (err instanceof KeineVerbindung) { setOnline(false); zeige({ art: 'keineVerbindung' }) }
      else zeige({ art: 'fehler', text: err instanceof Error ? err.message : 'Fehler' })
    } finally {
      setPruefe(false)
    }
  }, [event.id, zeige, onAbgemeldet])

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]"
      onPointerDown={freischalten}>
      <header className="flex items-start justify-between gap-3">
        <button type="button" onClick={onEventWechseln} className="min-w-0 text-left">
          <p className="truncate text-lg font-bold">{event.titel}</p>
          <p className="text-xs text-leise">{ich.geraet.name} · Event wechseln</p>
        </button>
        <div className="text-right">
          <p className="text-4xl font-black tabular-nums leading-none">{stand?.besucher ?? '–'}</p>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-leise">Besucher</p>
        </div>
      </header>

      {stand && (
        <p className="-mt-2 text-right text-xs text-leise">
          davon {stand.besucherMehrfach} Mehrfach (einmal gezählt) · {stand.tickets} Tickets gültig
        </p>
      )}
      {!online && (
        <p className="rounded-xl bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200">
          Keine Verbindung — Scans werden gerade NICHT geprüft.
        </p>
      )}

      {kamera ? (
        <Kamera onErkannt={(text) => void pruefen(text, 'kamera')} />
      ) : (
        <button
          type="button"
          onClick={() => { freischalten(); setKamera(true) }}
          className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-rand bg-flaeche text-lg font-semibold active:bg-rand"
        >
          <span className="text-5xl" aria-hidden>📷</span>
          Scannen starten
          <span className="text-xs font-normal text-leise">Kamera + Ton werden eingeschaltet</span>
        </button>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); const t = eingabe; setEingabe(''); void pruefen(t, 'eingabe') }}
      >
        <input
          ref={eingabeFeld}
          value={eingabe}
          onChange={e => setEingabe(e.target.value)}
          placeholder="Code eingeben oder Handscanner"
          autoFocus={!istTouch()}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-rand bg-flaeche px-3 py-3 font-mono text-base text-text placeholder:font-sans placeholder:text-leise focus:outline-none focus:ring-2 focus:ring-green-500/50"
        />
        <button type="submit" disabled={pruefe || !eingabe.trim()}
          className="rounded-xl bg-green-600 px-5 font-semibold text-white disabled:opacity-40">
          {pruefe ? '…' : 'Prüfen'}
        </button>
      </form>

      {stand && stand.proBand.some(b => b.anzahl > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {stand.proBand.filter(b => b.anzahl > 0).map(b => (
            <span key={b.bandId ?? 'ohne'} className="inline-flex items-center gap-1.5 rounded-full border border-rand px-2.5 py-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.farbe ?? '#6b7280' }} />
              {b.bezeichnung} <strong className="tabular-nums">{b.anzahl}</strong>
            </span>
          ))}
        </div>
      )}

      {anzeige && <Ergebnis anzeige={anzeige} onWeiter={weiter} />}
    </main>
  )
}
