/**
 * Abholmonitor — öffentlicher Wandbildschirm für SB-Bestellungen.
 *
 * Zwei Spalten: „Bestellt" (in Zubereitung) und „Zur Abholung bereit" —
 * NUR Bestellnummern, riesig, mit mitlaufender Wartezeit. Die Kachelgröße
 * skaliert mit der Anzahl (wenige = riesig, viele = kompakt mehrspaltig),
 * sodass immer alle Bestellungen sichtbar bleiben. SSE mit Auto-Reconnect.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

interface Eintrag {
  id:            string
  bestellNummer: number
  status:        'offen' | 'bereit'
  erstelltAt:    string
  bereitAt:      string | null
}

type MonitorEvent =
  | { typ: 'snapshot'; bestellungen: Eintrag[] }
  | { typ: 'update';   bestellung: Eintrag }
  | { typ: 'entfernt'; bestellungId: string }

export default function App() {
  const kasseId = useMemo(() => new URLSearchParams(window.location.search).get('kasseId') ?? '', [])
  const [eintraege, setEintraege] = useState<Map<string, Eintrag>>(new Map())
  const [verbunden, setVerbunden] = useState(false)
  const [jetzt, setJetzt] = useState(() => Date.now())
  /** IDs, die gerade auf „bereit" gewechselt sind → Blink-Animation */
  const [neuBereit, setNeuBereit] = useState<Set<string>>(new Set())
  const blinkTimer = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  // Wartezeit-Ticker (30 s reicht für Minutenanzeige)
  useEffect(() => {
    const t = setInterval(() => setJetzt(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // SSE mit Reconnect (3 s)
  useEffect(() => {
    if (!kasseId) return
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let beendet = false

    const markiereNeuBereit = (id: string) => {
      setNeuBereit(prev => new Set(prev).add(id))
      const alt = blinkTimer.current.get(id)
      if (alt) clearTimeout(alt)
      blinkTimer.current.set(id, setTimeout(() => {
        setNeuBereit(prev => { const n = new Set(prev); n.delete(id); return n })
        blinkTimer.current.delete(id)
      }, 6_000))
    }

    const connect = () => {
      if (beendet) return
      es = new EventSource(`/sse/abholung?kasseId=${encodeURIComponent(kasseId)}`)
      es.onopen = () => setVerbunden(true)
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as MonitorEvent
          setEintraege(prev => {
            const next = new Map(prev)
            if (ev.typ === 'snapshot') {
              next.clear()
              for (const b of ev.bestellungen) next.set(b.id, b)
            } else if (ev.typ === 'update') {
              const vorher = next.get(ev.bestellung.id)
              if (ev.bestellung.status === 'bereit' && vorher?.status !== 'bereit') {
                markiereNeuBereit(ev.bestellung.id)
              }
              next.set(ev.bestellung.id, ev.bestellung)
            } else if (ev.typ === 'entfernt') {
              next.delete(ev.bestellungId)
            }
            return next
          })
        } catch { /* ungültiges JSON ignorieren */ }
      }
      es.onerror = () => {
        setVerbunden(false)
        es?.close()
        es = null
        timer = setTimeout(connect, 3_000)
      }
    }
    connect()

    return () => {
      beendet = true
      if (timer) clearTimeout(timer)
      es?.close()
      for (const t of blinkTimer.current.values()) clearTimeout(t)
      blinkTimer.current.clear()
    }
  }, [kasseId])

  const alle    = [...eintraege.values()]
  const offen   = alle.filter(e => e.status === 'offen').sort((a, b) => a.erstelltAt.localeCompare(b.erstelltAt))
  const bereit  = alle.filter(e => e.status === 'bereit').sort((a, b) => (a.bereitAt ?? '').localeCompare(b.bereitAt ?? ''))

  if (!kasseId) {
    return (
      <div className="flex h-full items-center justify-center text-2xl text-ink-muted">
        URL-Parameter ?kasseId=… fehlt (siehe Einstellungen → SB-Terminal)
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 grid-cols-2 overflow-hidden">
        <Spalte
          titel="Bestellt"
          untertitel="wird zubereitet"
          eintraege={offen}
          jetzt={jetzt}
          variante="offen"
          neuBereit={neuBereit}
        />
        <Spalte
          titel="Zur Abholung bereit"
          untertitel="bitte abholen"
          eintraege={bereit}
          jetzt={jetzt}
          variante="bereit"
          neuBereit={neuBereit}
        />
      </div>
      {!verbunden && (
        <div className="bg-red-950 px-4 py-1.5 text-center text-sm text-red-300">
          Verbindung unterbrochen — verbinde neu…
        </div>
      )}
    </div>
  )
}

function Spalte({
  titel,
  untertitel,
  eintraege,
  jetzt,
  variante,
  neuBereit,
}: {
  titel:      string
  untertitel: string
  eintraege:  Eintrag[]
  jetzt:      number
  variante:   'offen' | 'bereit'
  neuBereit:  Set<string>
}) {
  const n = eintraege.length
  // Skalierung nach Anzahl: wenige riesig, viele kompakt in mehreren Spalten
  const stufe =
    n <= 4  ? { grid: 'grid-cols-1', nummer: 'text-8xl',  pad: 'p-6' } :
    n <= 8  ? { grid: 'grid-cols-2', nummer: 'text-7xl',  pad: 'p-5' } :
    n <= 15 ? { grid: 'grid-cols-2', nummer: 'text-5xl',  pad: 'p-4' } :
              { grid: 'grid-cols-3', nummer: 'text-4xl',  pad: 'p-3' }

  const istBereit = variante === 'bereit'

  return (
    <section className={`flex flex-col overflow-hidden ${istBereit ? 'bg-green-950/40' : ''} ${istBereit ? '' : 'border-r border-line'}`}>
      <header className={`shrink-0 px-8 py-5 border-b ${istBereit ? 'border-green-800 bg-green-900/40' : 'border-line bg-panel'}`}>
        <h1 className={`text-4xl font-black ${istBereit ? 'text-green-300' : 'text-ink'}`}>{titel}</h1>
        <p className={`mt-1 text-lg ${istBereit ? 'text-green-500' : 'text-ink-muted'}`}>{untertitel}</p>
      </header>

      <div className={`grid flex-1 auto-rows-min content-start gap-4 overflow-y-auto p-6 ${stufe.grid}`}>
        {eintraege.map(e => {
          const seitMin = Math.max(0, Math.floor((jetzt - new Date(istBereit ? (e.bereitAt ?? e.erstelltAt) : e.erstelltAt).getTime()) / 60_000))
          const zeitFarbe = istBereit
            ? 'text-green-600'
            : seitMin >= 15 ? 'text-red-400' : seitMin >= 8 ? 'text-amber-400' : 'text-ink-subtle'
          return (
            <div
              key={e.id}
              className={`flex flex-col items-center justify-center rounded-3xl ${stufe.pad} ${
                istBereit ? 'bg-green-600 text-white' : 'bg-panel text-ink border border-line'
              } ${neuBereit.has(e.id) ? 'neu-bereit' : ''}`}
            >
              <span className={`font-mono font-black leading-none tracking-wider ${stufe.nummer}`}>
                {String(e.bestellNummer).padStart(4, '0')}
              </span>
              <span className={`mt-2 text-base font-medium ${istBereit ? 'text-green-100' : zeitFarbe}`}>
                {istBereit ? `bereit seit ${seitMin} min` : `seit ${seitMin} min`}
              </span>
            </div>
          )
        })}
        {n === 0 && (
          <p className={`col-span-full mt-16 text-center text-2xl ${istBereit ? 'text-green-700' : 'text-ink-subtle'}`}>
            {istBereit ? 'Noch nichts bereit' : 'Keine offenen Bestellungen'}
          </p>
        )}
      </div>
    </section>
  )
}
