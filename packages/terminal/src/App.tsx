/**
 * SB-Terminal — Touch-Kiosk für Selbstbedienungs-Bestellungen.
 *
 * Ablauf: Ruhescreen → Sortiment/Warenkorb → Kartenzahlung (ZVT-Poll bzw.
 * Demo-Bestätigung ohne ZVT) → Erfolgsscreen mit riesiger Bestellnummer.
 * Auto-Reset: 15 s nach Erfolg, 90 s Inaktivität mitten im Bestellen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  terminalApi,
  formatNummer,
  formatPreis,
  TerminalApiError,
  type BestellungStatus,
  type TerminalSortiment,
} from './api'

type Screen = 'ruhe' | 'sortiment' | 'zahlung' | 'erfolg' | 'fehler'

const INAKTIV_RESET_MS = 90_000
const ERFOLG_RESET_MS  = 15_000
const POLL_MS          = 700

export default function App() {
  const kasseId = useMemo(() => new URLSearchParams(window.location.search).get('kasseId') ?? '', [])

  const [screen, setScreen]         = useState<Screen>('ruhe')
  const [sortiment, setSortiment]   = useState<TerminalSortiment | null>(null)
  const [kategorieId, setKategorie] = useState<string | 'alle'>('alle')
  const [korb, setKorb]             = useState<Map<string, number>>(new Map())
  const [bestellung, setBestellung] = useState<BestellungStatus | null>(null)
  const [fehlerText, setFehlerText] = useState('')

  const reset = useCallback(() => {
    setScreen('ruhe')
    setKorb(new Map())
    setBestellung(null)
    setFehlerText('')
    setKategorie('alle')
  }, [])

  // ── Inaktivitäts-Reset während des Bestellens ────────────────────────────────
  const inaktivTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (screen !== 'sortiment') {
      if (inaktivTimer.current) clearTimeout(inaktivTimer.current)
      return
    }
    const anstossen = () => {
      if (inaktivTimer.current) clearTimeout(inaktivTimer.current)
      inaktivTimer.current = setTimeout(reset, INAKTIV_RESET_MS)
    }
    anstossen()
    window.addEventListener('pointerdown', anstossen)
    return () => {
      window.removeEventListener('pointerdown', anstossen)
      if (inaktivTimer.current) clearTimeout(inaktivTimer.current)
    }
  }, [screen, reset])

  // ── Erfolg: automatisch zurück zum Ruhescreen ────────────────────────────────
  useEffect(() => {
    if (screen !== 'erfolg') return
    const t = setTimeout(reset, ERFOLG_RESET_MS)
    return () => clearTimeout(t)
  }, [screen, reset])

  // ── Zahlung: Status pollen bis offen/abgebrochen ─────────────────────────────
  useEffect(() => {
    if (screen !== 'zahlung' || !bestellung || bestellung.demoZahlung) return
    let aktiv = true
    const poll = async () => {
      if (!aktiv) return
      try {
        const s = await terminalApi.status(bestellung.id)
        if (!aktiv) return
        setBestellung(s)
        if (s.status === 'offen') { setScreen('erfolg'); return }
        if (s.status === 'abgebrochen') {
          setFehlerText('Die Zahlung wurde nicht abgeschlossen.')
          setScreen('fehler')
          return
        }
      } catch {
        // Netzwerk-Hänger: weiter pollen
      }
      setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => { aktiv = false }
  }, [screen, bestellung?.id, bestellung?.demoZahlung])

  // ── Aktionen ─────────────────────────────────────────────────────────────────
  const starten = async () => {
    try {
      setSortiment(await terminalApi.sortiment(kasseId))
      setScreen('sortiment')
    } catch (err) {
      setFehlerText(err instanceof TerminalApiError ? err.message : 'Terminal ist gerade nicht erreichbar.')
      setScreen('fehler')
    }
  }

  const bezahlen = async () => {
    const positionen = [...korb.entries()].map(([artikelId, menge]) => ({ artikelId, menge }))
    if (positionen.length === 0) return
    try {
      const b = await terminalApi.bestellen(kasseId, positionen)
      setBestellung(b)
      setScreen('zahlung')
    } catch (err) {
      setFehlerText(err instanceof TerminalApiError ? err.message : 'Bestellung konnte nicht angelegt werden.')
      setScreen('fehler')
    }
  }

  const demoBestaetigen = async () => {
    if (!bestellung) return
    try {
      const s = await terminalApi.bestaetigen(bestellung.id)
      setBestellung(s)
      setScreen(s.status === 'offen' ? 'erfolg' : 'fehler')
    } catch (err) {
      setFehlerText(err instanceof TerminalApiError ? err.message : 'Bestätigung fehlgeschlagen.')
      setScreen('fehler')
    }
  }

  const zahlungAbbrechen = async () => {
    if (bestellung) {
      try { await terminalApi.abbrechen(bestellung.id) } catch { /* egal — zurück zum Start */ }
    }
    reset()
  }

  // ── Screens ──────────────────────────────────────────────────────────────────
  if (!kasseId) {
    return (
      <Zentriert>
        <p className="text-2xl font-semibold text-ink">Keine Kasse konfiguriert</p>
        <p className="mt-2 text-ink-muted">Die Terminal-URL braucht den Parameter <code>?kasseId=…</code> (siehe Einstellungen → SB-Terminal).</p>
      </Zentriert>
    )
  }

  if (screen === 'ruhe') {
    return (
      <button type="button" onClick={starten} className="flex h-full w-full flex-col items-center justify-center gap-8 bg-surface">
        <span className="text-7xl">🛒</span>
        <span className="text-4xl font-bold text-ink">Zum Bestellen tippen</span>
        <span className="rounded-full bg-brand-600 px-10 py-5 text-2xl font-semibold text-white shadow-lg">
          Jetzt bestellen
        </span>
        <span className="text-ink-subtle">Bezahlung mit Karte direkt am Terminal</span>
      </button>
    )
  }

  if (screen === 'sortiment' && sortiment) {
    return (
      <SortimentScreen
        sortiment={sortiment}
        kategorieId={kategorieId}
        onKategorie={setKategorie}
        korb={korb}
        onKorb={setKorb}
        onBezahlen={bezahlen}
        onAbbrechen={reset}
      />
    )
  }

  if (screen === 'zahlung' && bestellung) {
    return (
      <Zentriert>
        <span className="text-7xl">💳</span>
        {bestellung.demoZahlung ? (
          <>
            <p className="text-3xl font-bold text-ink">Zahlung: {formatPreis(bestellung.summeCent)}</p>
            <p className="max-w-md text-center text-ink-muted">
              Demo-Modus (kein Kartenterminal konfiguriert) — Zahlung zum Testen direkt bestätigen.
            </p>
            <button
              type="button"
              onClick={demoBestaetigen}
              className="rounded-full bg-brand-600 px-10 py-5 text-2xl font-semibold text-white shadow-lg"
            >
              Zahlung bestätigen (Demo)
            </button>
          </>
        ) : (
          <>
            <p className="text-3xl font-bold text-ink">Bitte Karte ans Terminal halten</p>
            <p className="text-2xl font-semibold text-brand-600">{formatPreis(bestellung.summeCent)}</p>
            <p className="min-h-6 text-ink-muted">{bestellung.zahlung?.meldung ?? 'Verbinde mit Kartenterminal…'}</p>
            <Spinner />
          </>
        )}
        <button type="button" onClick={zahlungAbbrechen} className="mt-4 text-lg text-ink-muted underline">
          Abbrechen
        </button>
      </Zentriert>
    )
  }

  if (screen === 'erfolg' && bestellung) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-brand-600 text-white">
        <p className="text-3xl font-semibold">Danke für deine Bestellung!</p>
        <p className="text-2xl opacity-90">Deine Bestellnummer</p>
        <p className="font-mono text-[9rem] font-black leading-none tracking-wider">
          {formatNummer(bestellung.bestellNummer)}
        </p>
        <p className="max-w-md text-center text-xl opacity-90">
          Behalte den Abholbildschirm im Blick — sobald deine Nummer bei
          „Zur Abholung bereit" erscheint, kannst du deine Bestellung abholen.
        </p>
        <button type="button" onClick={reset} className="mt-6 rounded-full bg-white/15 px-8 py-4 text-xl font-semibold">
          Neue Bestellung
        </button>
      </div>
    )
  }

  // Fehler
  return (
    <Zentriert>
      <span className="text-7xl">😕</span>
      <p className="text-3xl font-bold text-ink">Das hat leider nicht geklappt</p>
      <p className="max-w-md text-center text-lg text-ink-muted">{fehlerText || 'Bitte versuche es noch einmal.'}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-brand-600 px-10 py-5 text-2xl font-semibold text-white shadow-lg"
      >
        Zurück zum Start
      </button>
    </Zentriert>
  )
}

// ---------------------------------------------------------------------------
// Sortiment + Warenkorb
// ---------------------------------------------------------------------------

function SortimentScreen({
  sortiment,
  kategorieId,
  onKategorie,
  korb,
  onKorb,
  onBezahlen,
  onAbbrechen,
}: {
  sortiment:   TerminalSortiment
  kategorieId: string | 'alle'
  onKategorie: (id: string | 'alle') => void
  korb:        Map<string, number>
  onKorb:      (k: Map<string, number>) => void
  onBezahlen:  () => void
  onAbbrechen: () => void
}) {
  const artikel = kategorieId === 'alle'
    ? sortiment.artikel
    : sortiment.artikel.filter(a => a.kategorieId === kategorieId)

  const anzahl = [...korb.values()].reduce((s, m) => s + m, 0)
  const summe  = [...korb.entries()].reduce((s, [id, menge]) => {
    const a = sortiment.artikel.find(x => x.id === id)
    return s + (a ? a.preisBruttoCent * menge : 0)
  }, 0)

  const aendern = (artikelId: string, delta: number) => {
    const next = new Map(korb)
    const menge = (next.get(artikelId) ?? 0) + delta
    if (menge <= 0) next.delete(artikelId)
    else next.set(artikelId, Math.min(99, menge))
    onKorb(next)
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Kopf */}
      <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-6 py-4">
        <div>
          <p className="text-xl font-bold text-ink">{sortiment.kasse.firmenname}</p>
          <p className="text-sm text-ink-muted">Selbstbedienung — bezahle mit Karte</p>
        </div>
        <button type="button" onClick={onAbbrechen} className="rounded-lg border border-line px-4 py-2 text-ink-muted">
          Abbrechen
        </button>
      </header>

      {/* Kategorie-Tabs */}
      <nav className="flex gap-2 overflow-x-auto border-b border-line bg-panel px-6 py-3">
        <KategorieTab label="Alle" aktiv={kategorieId === 'alle'} onClick={() => onKategorie('alle')} />
        {sortiment.kategorien.map(k => (
          <KategorieTab key={k.id} label={k.name} aktiv={kategorieId === k.id} onClick={() => onKategorie(k.id)} />
        ))}
      </nav>

      {/* Artikel-Raster */}
      <main className="grid flex-1 auto-rows-min grid-cols-2 gap-4 overflow-y-auto p-6 sm:grid-cols-3 lg:grid-cols-4">
        {artikel.map(a => {
          const menge = korb.get(a.id) ?? 0
          return (
            <div key={a.id} className={`flex flex-col overflow-hidden rounded-2xl border-2 bg-panel shadow-sm transition ${menge > 0 ? 'border-brand-500' : 'border-line'}`}>
              <button type="button" onClick={() => aendern(a.id, +1)} className="flex flex-1 flex-col text-left">
                {a.bild ? (
                  <img src={a.bild} alt="" className="h-28 w-full object-cover" />
                ) : (
                  <div className="flex h-28 w-full items-center justify-center bg-panel-2 text-4xl">🍽️</div>
                )}
                <div className="flex flex-1 flex-col justify-between p-3">
                  <p className="text-base font-semibold leading-snug text-ink">{a.bezeichnung}</p>
                  <p className="mt-1 text-lg font-bold text-brand-600">{formatPreis(a.preisBruttoCent)}</p>
                </div>
              </button>
              {menge > 0 && (
                <div className="flex items-center justify-between border-t border-line bg-brand-50 px-3 py-2">
                  <MengenButton label="−" onClick={() => aendern(a.id, -1)} />
                  <span className="text-xl font-bold text-brand-700">{menge}</span>
                  <MengenButton label="+" onClick={() => aendern(a.id, +1)} />
                </div>
              )}
            </div>
          )
        })}
        {artikel.length === 0 && (
          <p className="col-span-full py-16 text-center text-ink-muted">Keine Artikel in dieser Gruppe.</p>
        )}
      </main>

      {/* Warenkorb-Leiste */}
      <footer className="border-t border-line bg-panel px-6 py-4">
        <button
          type="button"
          disabled={anzahl === 0}
          onClick={onBezahlen}
          className={`flex w-full items-center justify-between rounded-2xl px-6 py-5 text-2xl font-bold transition ${
            anzahl > 0 ? 'bg-brand-600 text-white shadow-lg' : 'bg-panel-2 text-ink-subtle'
          }`}
        >
          <span>{anzahl === 0 ? 'Warenkorb ist leer' : `${anzahl} Artikel`}</span>
          <span>{anzahl > 0 ? `Mit Karte zahlen · ${formatPreis(summe)}` : ''}</span>
        </button>
      </footer>
    </div>
  )
}

function KategorieTab({ label, aktiv, onClick }: { label: string; aktiv: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full px-5 py-2.5 text-base font-semibold transition ${
        aktiv ? 'bg-brand-600 text-white' : 'bg-panel-2 text-ink-muted'
      }`}
    >
      {label}
    </button>
  )
}

function MengenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-2xl font-bold text-white"
    >
      {label}
    </button>
  )
}

function Zentriert({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-5 bg-surface px-6">{children}</div>
}

function Spinner() {
  return (
    <div className="h-12 w-12 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
  )
}
