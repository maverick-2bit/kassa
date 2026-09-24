import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EINLASS_ERGEBNIS_TITEL,
  EINLASS_ZUGELASSEN,
  ticketCodeAusScan,
  type EinlassEvent,
  type EinlassIch,
  type EinlassSyncErgebnis,
  type TicketEinlassStand,
} from '@kassa/shared'
import { KeineVerbindung, NichtAngemeldet, einlassApi } from './lib/api'
import { freischalten, signal } from './lib/feedback'
import { uhrzeit } from './lib/format'
import { OfflineEinlass } from './lib/offline'
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
/** Abgleich im Hintergrund: Offline-Scans nachreichen, Liste + Besucherzahl auffrischen */
const ABGLEICH_MS = 15_000

const istTouch = () => window.matchMedia('(pointer: coarse)').matches

type OfflineZustand =
  | { art: 'laedt' }
  | { art: 'kein_speicher' }
  | { art: 'bereit'; o: OfflineEinlass }

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
  const [offline, setOffline]   = useState<OfflineZustand>({ art: 'laedt' })
  const [, setTakt]             = useState(0)   // Neuzeichnen nach Änderungen am Offline-Zustand
  const [konflikte, setKonflikte] = useState<EinlassSyncErgebnis[]>([])
  const [zeigeKonflikte, setZeigeKonflikte] = useState(false)
  const eingabeFeld = useRef<HTMLInputElement>(null)
  const beschaeftigt = useRef(false)
  const abgleichLaeuft = useRef(false)
  const letzter = useRef<{ inhalt: string; zeit: number } | null>(null)
  const ausblenden = useRef<ReturnType<typeof setTimeout> | null>(null)
  const o = offline.art === 'bereit' ? offline.o : null
  const neuZeichnen = () => setTakt(t => t + 1)

  // Offline-Liste aus dem Gerätespeicher — steht sofort bereit, auch ohne Netz
  useEffect(() => {
    let aktiv = true
    OfflineEinlass.laden(event.id)
      .then(geladen => { if (aktiv) setOffline({ art: 'bereit', o: geladen }) })
      .catch(() => { if (aktiv) setOffline({ art: 'kein_speicher' }) })
    return () => { aktiv = false }
  }, [event.id])

  /**
   * Abgleich: zuerst offline entschiedene Scans nachreichen (Konflikte
   * sammeln), dann die Liste auffrischen — die bringt die Besucherzahl mit.
   */
  const abgleich = useCallback(async () => {
    if (abgleichLaeuft.current) return
    abgleichLaeuft.current = true
    try {
      if (o) {
        if (o.wartend > 0) {
          const r = await o.nachreichen()
          if (r.konflikte.length > 0) setKonflikte(k => [...r.konflikte, ...k].slice(0, 50))
        }
        await o.aktualisieren()
        setStand(o.meta?.stand ?? null)
      } else {
        setStand(await einlassApi.stand(event.id))
      }
      setOnline(true)
    } catch (err) {
      if (err instanceof NichtAngemeldet) onAbgemeldet(err.message)
      else if (err instanceof KeineVerbindung) setOnline(false)
    } finally {
      abgleichLaeuft.current = false
      neuZeichnen()
    }
  }, [o, event.id, onAbgemeldet])

  useEffect(() => {
    if (offline.art === 'laedt') return
    void abgleich()
    const t = setInterval(() => void abgleich(), ABGLEICH_MS)
    const wiederDa = () => void abgleich()
    window.addEventListener('online', wiederDa)
    return () => { clearInterval(t); window.removeEventListener('online', wiederDa) }
  }, [abgleich, offline.art])

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
      if (o) void o.uebernehmeOnline(ergebnis)
      signal(ergebnis.ergebnis === 'zugelassen' ? 'ok' : ergebnis.ergebnis === 'mehrfach' ? 'mehrfach' : 'nein')
      zeige({ art: 'ergebnis', ergebnis, offline: false })
    } catch (err) {
      if (err instanceof NichtAngemeldet) { onAbgemeldet(err.message); return }
      if (err instanceof KeineVerbindung) setOnline(false)
      // Kein Netz, aber eine Liste auf dem Gerät: selbst entscheiden und später nachreichen
      if (err instanceof KeineVerbindung && o?.bereit) {
        const e = o.entscheide(ticketCodeAusScan(text))
        await o.vermerke(text, e, ich.geraet.name)
        neuZeichnen()
        signal(e.ergebnis === 'zugelassen' ? 'ok' : e.ergebnis === 'mehrfach' ? 'mehrfach' : 'nein')
        zeige({
          art: 'ergebnis', offline: true, listeVon: o.meta?.erstelltAt ?? null,
          ergebnis: {
            ergebnis: e.ergebnis, zugelassen: EINLASS_ZUGELASSEN.has(e.ergebnis), ticket: e.ticket,
            stand: o.meta!.stand,
          },
        })
        return
      }
      // Nicht geprüft = nicht eingelöst: derselbe Code darf sofort erneut versucht werden
      letzter.current = null
      signal('nein')
      if (err instanceof KeineVerbindung) zeige({ art: 'keineVerbindung' })
      else zeige({ art: 'fehler', text: err instanceof Error ? err.message : 'Fehler' })
    } finally {
      setPruefe(false)
    }
  }, [event.id, zeige, onAbgemeldet, o, ich.geraet.name])

  const besucher = o ? o.besucher(online ? stand : null) : stand?.besucher ?? null
  const standZeigen = stand ?? o?.meta?.stand ?? null

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]"
      onPointerDown={freischalten}>
      <header className="flex items-start justify-between gap-3">
        <button type="button" onClick={onEventWechseln} className="min-w-0 text-left">
          <p className="truncate text-lg font-bold">{event.titel}</p>
          <p className="text-xs text-leise">{ich.geraet.name} · Event wechseln</p>
        </button>
        <div className="text-right">
          <p className="text-4xl font-black tabular-nums leading-none">
            {!online && besucher !== null && <span className="text-2xl align-top">≈</span>}{besucher ?? '–'}
          </p>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-leise">Besucher</p>
        </div>
      </header>

      {standZeigen && (
        <p className="-mt-2 text-right text-xs text-leise">
          davon {standZeigen.besucherMehrfach} Mehrfach (einmal gezählt) · {standZeigen.tickets} Tickets gültig
        </p>
      )}

      <OfflineStatus online={online} zustand={offline} />

      {konflikte.length > 0 && (
        <button type="button" onClick={() => setZeigeKonflikte(true)}
          className="rounded-xl bg-amber-500/20 px-4 py-2 text-left text-sm font-semibold text-amber-100">
          ⚠ {konflikte.length} {konflikte.length === 1 ? 'Konflikt' : 'Konflikte'} beim Nachreichen — antippen für Details
        </button>
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

      {standZeigen && standZeigen.proBand.some(b => b.anzahl > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {standZeigen.proBand.filter(b => b.anzahl > 0).map(b => (
            <span key={b.bandId ?? 'ohne'} className="inline-flex items-center gap-1.5 rounded-full border border-rand px-2.5 py-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.farbe ?? '#6b7280' }} />
              {b.bezeichnung} <strong className="tabular-nums">{b.anzahl}</strong>
            </span>
          ))}
        </div>
      )}

      {anzeige && <Ergebnis anzeige={anzeige} onWeiter={weiter} />}

      {zeigeKonflikte && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/80 p-4" role="dialog" aria-label="Konflikte">
          <div className="mx-auto w-full max-w-md flex-1 overflow-y-auto rounded-2xl bg-flaeche p-4">
            <h2 className="text-lg font-bold">Konflikte beim Nachreichen</h2>
            <p className="mt-1 text-sm text-leise">
              Diese Gäste wurden ohne Verbindung eingelassen, der Server hätte sie abgewiesen — meist eine
              Ticket-Kopie an einem zweiten Eingang. Der Veranstalter sieht sie im Einlass-Protokoll.
            </p>
            <ul className="mt-3 space-y-2">
              {konflikte.map(k => (
                <li key={k.scanId} className="rounded-xl border border-rand p-3 text-sm">
                  <p className="font-semibold">{EINLASS_ERGEBNIS_TITEL[k.ergebnis]}</p>
                  {k.ticket && (
                    <p className="text-leise">
                      {k.ticket.bezeichnung}{k.ticket.name ? ` · ${k.ticket.name}` : ''}
                      {k.ergebnis === 'bereits_eingeloest' && k.ticket.ersterEinlassAt
                        ? ` · zuerst um ${uhrzeit(k.ticket.ersterEinlassAt)} Uhr${k.ticket.ersterEinlassGeraet ? ` (${k.ticket.ersterEinlassGeraet})` : ''}`
                        : ''}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <button type="button" onClick={() => { setKonflikte([]); setZeigeKonflikte(false) }}
            className="mx-auto mt-3 w-full max-w-md rounded-xl bg-green-600 py-3 font-semibold text-white">
            Gesehen
          </button>
        </div>
      )}
    </main>
  )
}

/** Verbindung + Offline-Liste auf einen Blick — das Personal soll wissen, worauf es sich verlässt. */
function OfflineStatus({ online, zustand }: { online: boolean; zustand: OfflineZustand }) {
  if (zustand.art === 'laedt') return null
  if (zustand.art === 'kein_speicher') {
    return !online ? (
      <p className="rounded-xl bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200">
        Keine Verbindung — und dieses Gerät kann keine Offline-Liste speichern. Scans werden NICHT geprüft.
      </p>
    ) : null
  }
  const { o } = zustand
  if (!o.bereit) {
    return (
      <p className={`rounded-xl px-4 py-2 text-sm font-semibold ${online ? 'bg-flaeche text-leise' : 'bg-red-500/15 text-red-200'}`}>
        {online ? 'Offline-Liste wird geladen …' : 'Keine Verbindung und noch keine Offline-Liste — Scans werden NICHT geprüft.'}
      </p>
    )
  }
  const stand = o.meta ? uhrzeit(o.meta.erstelltAt) : '–'
  return online ? (
    <p className="text-xs text-leise">
      ● online · Offline-Liste bereit ({o.anzahlTickets} Tickets, Stand {stand})
      {o.wartend > 0 && <> · {o.wartend} Scans werden nachgereicht</>}
    </p>
  ) : (
    <p className="rounded-xl bg-amber-500/20 px-4 py-2 text-sm font-semibold text-amber-100">
      ● OFFLINE — geprüft wird mit der Liste von {stand} Uhr. {o.wartend > 0 ? `${o.wartend} Scans warten aufs Nachreichen.` : ''}
    </p>
  )
}
