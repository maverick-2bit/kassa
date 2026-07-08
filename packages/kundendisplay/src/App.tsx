/**
 * Kundendisplay — zeigt den aktuellen Warenkorb der Kasse in Echtzeit.
 *
 * URL: http://<server>:8081?kasseId=<uuid>&mandantId=<uuid>
 *
 * Zustände:
 *   leer          → Werbefolien-Slideshow (wenn mandantId gesetzt und Folien vorhanden)
 *   warenkorb     → Artikel-Liste mit laufender Summe
 *   beleg_erstellt → Dankeschön-Bildschirm (5 Sekunden)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'

// ---------------------------------------------------------------------------
// Typen (gespiegelt vom Backend display-event-bus.ts)
// ---------------------------------------------------------------------------

interface DisplayPosition {
  bezeichnung: string
  menge:       number
  preisCent:   number
}

type DisplayEvent =
  | { typ: 'warenkorb';     positionen: DisplayPosition[]; summeCent: number }
  | { typ: 'beleg_erstellt'; belegNummer: number; summeCent: number; belegId?: string; belegUrl?: string }
  | { typ: 'leer' }

// ---------------------------------------------------------------------------
// Hilfsfunktion
// ---------------------------------------------------------------------------

function formatPreis(cent: number): string {
  return (cent / 100).toLocaleString('de-AT', { style: 'currency', currency: 'EUR' })
}

// ---------------------------------------------------------------------------
// SSE-Hook
// ---------------------------------------------------------------------------

function useDisplaySse(kasseId: string, onEvent: (e: DisplayEvent) => void) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    const connect = () => {
      if (destroyed) return
      es = new EventSource(`/sse/display?kasseId=${kasseId}`)
      es.onmessage = (e) => {
        try { onEventRef.current(JSON.parse(e.data) as DisplayEvent) } catch {}
      }
      es.onerror = () => {
        es?.close()
        es = null
        if (!destroyed) reconnectTimer = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [kasseId])
}

// ---------------------------------------------------------------------------
// Uhr-Komponente
// ---------------------------------------------------------------------------

function Uhrzeit() {
  const [zeit, setZeit] = useState(() =>
    new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
  )
  useEffect(() => {
    const id = setInterval(() =>
      setZeit(new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }))
    , 10_000)
    return () => clearInterval(id)
  }, [])
  return <>{zeit}</>
}

// ---------------------------------------------------------------------------
// Haupt-App
// ---------------------------------------------------------------------------

export default function App() {
  const params    = new URLSearchParams(window.location.search)
  const kasseId   = params.get('kasseId')   ?? ''
  const mandantId = params.get('mandantId') ?? ''
  const [state, setState] = useState<DisplayEvent>({ typ: 'leer' })

  useDisplaySse(kasseId, useCallback((ev) => setState(ev), []))

  if (!kasseId) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-ink-subtle text-lg">Keine kasseId in der URL angegeben.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface text-ink flex flex-col select-none">
      {/* Header-Leiste */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-line">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600">
            <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </span>
          <span className="font-semibold text-ink text-lg">Ihre Bestellung</span>
        </div>
        <span className="text-ink-muted text-xl font-mono tabular-nums"><Uhrzeit /></span>
      </div>

      {/* Haupt-Bereich */}
      <div className="flex-1 flex flex-col">
        {state.typ === 'leer' && <LeerBildschirm mandantId={mandantId} />}
        {state.typ === 'warenkorb' && <WarenkorbAnsicht positionen={state.positionen} summeCent={state.summeCent} />}
        {state.typ === 'beleg_erstellt' && <DankeschoenBildschirm belegNummer={state.belegNummer} summeCent={state.summeCent} belegUrl={state.belegUrl} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Leerer Bildschirm
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Werbefolien-Typen
// ---------------------------------------------------------------------------

interface Werbefolie {
  id:              string
  titel:           string
  bildBase64:      string
  mimeType:        string
  anzeigedauerSek: number
}

function useWerbefolien(mandantId: string) {
  const [folien, setFolien] = useState<Werbefolie[]>([])
  const etagRef = useRef<string | null>(null)

  useEffect(() => {
    if (!mandantId) return
    const laden = async () => {
      try {
        const res = await fetch(`/api/werbefolien/public/${mandantId}`, {
          headers: etagRef.current ? { 'If-None-Match': etagRef.current } : {},
        })
        if (res.status === 304) return // unverändert — Bilder nicht neu übertragen
        if (res.ok) {
          etagRef.current = res.headers.get('ETag')
          setFolien(await res.json() as Werbefolie[])
        }
      } catch {}
    }
    laden()
    const id = setInterval(laden, 60_000) // alle 60s auf Änderungen prüfen
    return () => clearInterval(id)
  }, [mandantId])

  return folien
}

function LeerBildschirm({ mandantId }: { mandantId: string }) {
  const folien  = useWerbefolien(mandantId)
  const [index, setIndex] = useState(0)
  const aktive  = folien.filter(f => f.bildBase64)

  useEffect(() => {
    if (aktive.length < 2) return
    const folie = aktive[index]
    if (!folie) return
    const id = setTimeout(() => setIndex(i => (i + 1) % aktive.length), folie.anzeigedauerSek * 1000)
    return () => clearTimeout(id)
  }, [index, aktive])

  if (aktive.length > 0) {
    const folie = aktive[index % aktive.length]!
    return (
      <div className="flex-1 relative overflow-hidden bg-black">
        <img
          key={folie.id}
          src={`data:${folie.mimeType};base64,${folie.bildBase64}`}
          alt={folie.titel || 'Werbung'}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-1000"
        />
        {folie.titel && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-8 py-6">
            <p className="text-white text-2xl font-bold">{folie.titel}</p>
          </div>
        )}
        {aktive.length > 1 && (
          <div className="absolute bottom-4 right-4 flex gap-1.5">
            {aktive.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded-full transition-all ${i === index % aktive.length ? 'w-6 bg-white' : 'w-2 bg-white/40'}`}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-12">
      <div className="w-24 h-24 rounded-full bg-panel-2 flex items-center justify-center">
        <svg className="h-12 w-12 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
        </svg>
      </div>
      <div className="text-center space-y-2">
        <p className="text-2xl font-semibold text-ink-muted">Willkommen</p>
        <p className="text-ink-subtle">Ihre Bestellungen werden hier angezeigt.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Warenkorb-Ansicht
// ---------------------------------------------------------------------------

function WarenkorbAnsicht({ positionen, summeCent }: { positionen: DisplayPosition[]; summeCent: number }) {
  return (
    <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full px-8 py-6 gap-4">
      {/* Positions-Liste */}
      <div className="flex-1 space-y-2 overflow-auto">
        {positionen.map((pos, i) => (
          <div
            key={i}
            className="flex items-center justify-between bg-panel rounded-xl px-5 py-4 border border-line"
          >
            <div className="flex items-center gap-4">
              <span className="text-2xl font-black text-amber-400 w-10 text-right shrink-0">
                {pos.menge}×
              </span>
              <span className="text-xl font-semibold text-ink">{pos.bezeichnung}</span>
            </div>
            <span className="text-xl font-mono font-semibold text-ink-muted shrink-0 ml-4">
              {formatPreis(pos.preisCent * pos.menge)}
            </span>
          </div>
        ))}
      </div>

      {/* Summen-Leiste */}
      <div className="border-t border-line-strong pt-4 flex items-center justify-between">
        <span className="text-2xl font-bold text-ink">Gesamt</span>
        <span className="text-4xl font-black text-ink font-mono tabular-nums">
          {formatPreis(summeCent)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dankeschön-Bildschirm
// ---------------------------------------------------------------------------

function DankeschoenBildschirm({ belegNummer, summeCent, belegUrl }: { belegNummer: number; summeCent: number; belegUrl?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-12">
      {!belegUrl && (
        <div className="w-28 h-28 rounded-full bg-emerald-900/50 border-4 border-emerald-500 flex items-center justify-center">
          <svg className="h-14 w-14 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
      )}
      <div className="text-center space-y-2">
        <p className="text-4xl font-black text-emerald-400">Danke!</p>
        <p className="text-xl text-ink-muted">
          Beleg <span className="font-mono font-bold">#{belegNummer}</span>
        </p>
        <p className="text-3xl font-black font-mono text-ink tabular-nums">
          {formatPreis(summeCent)}
        </p>
      </div>
      {/* Digitaler Beleg: QR zum Scannen */}
      {belegUrl && (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-white p-4">
            <QRCodeSVG value={belegUrl} size={220} level="M" includeMargin />
          </div>
          <p className="text-2xl font-bold text-ink">Beleg scannen</p>
          <p className="text-base text-ink-muted">QR-Code mit dem Handy scannen — Ihr Beleg zum Mitnehmen</p>
        </div>
      )}
    </div>
  )
}
