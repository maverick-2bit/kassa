import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { type Lang, TRANSLATIONS, detectLang } from './i18n'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface GastArtikel {
  id:              string
  bezeichnung:     string
  preisBruttoCent: number
  kategorieId:     string | null
  reihenfolge:     number
}

interface GastKategorie {
  id:          string
  name:        string
  reihenfolge: number
}

interface Karte {
  kasse:               { id: string; bezeichnung: string }
  gastBestellungAktiv?: boolean
  kategorien:          GastKategorie[]
  artikel:             GastArtikel[]
}

interface KorbItem {
  artikel:    GastArtikel
  menge:      number
}

interface BelegDto {
  belegNummer:          number
  belegDatum:           string
  gesamtbetragCent:     number
  maschinenlesbareCode: string
  positionen:           { bezeichnung: string; menge: number; einzelpreisBreutto: number }[]
}
interface StatusDto {
  id:        string
  status:    'zahlung' | 'bezahlt' | 'abgebrochen'
  summeCent: number
  belegId:   string | null
  beleg:     { firmenname: string; beleg: BelegDto } | null
}

type Phase = 'laden' | 'fehler' | 'karte' | 'bestaetigung' | 'danke'
           | 'zahlung' | 'status' | 'abbruch' | 'beleg'

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

function getParams() {
  const p = new URLSearchParams(window.location.search)
  return {
    kasseId:     p.get('kasseId') ?? '',
    tischNummer: p.get('tisch')   ?? p.get('tischNummer') ?? '',
    bestellung:  p.get('bestellung') ?? '',
    abbruch:     p.get('abbruch') === '1',
  }
}

function formatPreis(cent: number): string {
  return `€ ${(cent / 100).toFixed(2).replace('.', ',')}`
}

/** Freie €-Eingabe („2,50" / „2.50") → Cent, ≥ 0, gedeckelt bei 1000 €. */
function parseEuroCent(text: string): number {
  const norm = text.replace(/\s|€/g, '').replace(',', '.')
  const euro = Number.parseFloat(norm)
  if (!Number.isFinite(euro) || euro <= 0) return 0
  return Math.min(100_000, Math.round(euro * 100))
}

const LANGS: { code: Lang; label: string }[] = [
  { code: 'de', label: 'DE' },
  { code: 'en', label: 'EN' },
  { code: 'it', label: 'IT' },
]

function wechsleLang(lang: Lang) {
  const url = new URL(window.location.href)
  url.searchParams.set('lang', lang)
  window.history.replaceState(null, '', url.toString())
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { kasseId, tischNummer, bestellung, abbruch } = getParams()
  const [phase, setPhase]       = useState<Phase>('laden')
  const [fehler, setFehler]     = useState('')
  const [karte, setKarte]       = useState<Karte | null>(null)
  const [korb, setKorb]         = useState<KorbItem[]>([])
  const [aktivKat, setAktivKat] = useState<string | null>(null)
  const [senden, setSenden]     = useState(false)
  const [trinkgeldInput, setTrinkgeldInput] = useState('')
  const [lang, setLang]         = useState<Lang>(detectLang)
  const [demoBestellId, setDemoBestellId] = useState('')
  const [bestellStatus, setBestellStatus] = useState<StatusDto | null>(null)

  const t = TRANSLATIONS[lang]
  const aktiveBestellId = bestellung || demoBestellId

  function switchLang(l: Lang) {
    setLang(l)
    wechsleLang(l)
  }

  // Menü laden (immer — auch bei Rückkehr von der Zahlung, damit „weitere Bestellung" geht)
  useEffect(() => {
    if (!kasseId) {
      setFehler(t.fehlerQr)
      setPhase('fehler')
      return
    }
    fetch(`/api/gast/karte?kasseId=${encodeURIComponent(kasseId)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<Karte>
      })
      .then(data => {
        setKarte(data)
        setAktivKat(data.kategorien[0]?.id ?? null)
        // Rückkehr von Stripe? Sonst normale Speisekarte.
        if (bestellung && abbruch) setPhase('abbruch')
        else if (bestellung)       setPhase('status')
        else                       setPhase('karte')
      })
      .catch(e => {
        setFehler(e instanceof Error ? e.message : t.fehlerLaden)
        setPhase('fehler')
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kasseId])

  // Zahlungsstatus pollen, sobald wir im Status-Screen sind
  useEffect(() => {
    if (phase !== 'status' || !aktiveBestellId) return
    let gestoppt = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/gast/bestellung/${aktiveBestellId}`)
        if (r.ok) {
          const st = await r.json() as StatusDto
          if (st.status === 'bezahlt')     { setBestellStatus(st); setPhase('beleg'); return }
          if (st.status === 'abgebrochen') { setPhase('abbruch'); return }
        }
      } catch { /* weiter versuchen */ }
      if (!gestoppt) setTimeout(() => void poll(), 1200)
    }
    void poll()
    return () => { gestoppt = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, aktiveBestellId])

  // Korb-Helfer
  function aendereMenge(artikel: GastArtikel, delta: number) {
    setKorb(prev => {
      const idx = prev.findIndex(k => k.artikel.id === artikel.id)
      if (idx === -1 && delta > 0) return [...prev, { artikel, menge: delta }]
      if (idx === -1) return prev
      const neueMenge = prev[idx]!.menge + delta
      if (neueMenge <= 0) return prev.filter((_, i) => i !== idx)
      return prev.map((k, i) => i === idx ? { ...k, menge: neueMenge } : k)
    })
  }

  function mengeVon(artikelId: string): number {
    return korb.find(k => k.artikel.id === artikelId)?.menge ?? 0
  }

  const gesamtCent  = korb.reduce((s, k) => s + k.artikel.preisBruttoCent * k.menge, 0)
  const gesamtMenge = korb.reduce((s, k) => s + k.menge, 0)
  const bezahlModus = karte?.gastBestellungAktiv ?? false
  const trinkgeldCent = bezahlModus ? parseEuroCent(trinkgeldInput) : 0
  const gesamtMitTrinkgeld = gesamtCent + trinkgeldCent

  const artikelInKat = useMemo(() =>
    karte?.artikel.filter(a => a.kategorieId === aktivKat) ?? [],
    [karte, aktivKat]
  )

  const positionenBody = () => korb.map(k => ({ artikelId: k.artikel.id, menge: k.menge }))

  // Alt-Modus: unbezahlte Bestellung → Tab beim Personal
  async function bestellungUnbezahlt() {
    setSenden(true)
    try {
      const res = await fetch('/api/gast/bestellung', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kasseId, tischNummer: tischNummer || 'Unbekannt', positionen: positionenBody() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPhase('danke')
    } catch {
      alert(t.fehlerSenden)
    } finally {
      setSenden(false)
    }
  }

  // Bezahl-Modus: Checkout starten → Stripe-Redirect (oder Demo → direkt Status)
  async function bestellungBezahlen() {
    setSenden(true)
    try {
      const res = await fetch('/api/gast/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kasseId, tischNummer: tischNummer || 'Unbekannt', positionen: positionenBody(), trinkgeldCent }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { bestellungId, checkoutUrl } = await res.json() as { bestellungId: string; checkoutUrl: string | null }
      if (checkoutUrl) {
        setPhase('zahlung')
        window.location.href = checkoutUrl   // → Stripe-Bezahlseite
        return
      }
      // Demo-Pfad (kein Stripe): sofort finalisiert → Status pollen
      setDemoBestellId(bestellungId)
      setPhase('status')
    } catch {
      alert(t.fehlerSenden)
    } finally {
      setSenden(false)
    }
  }

  function absenden() {
    if (karte?.gastBestellungAktiv) void bestellungBezahlen()
    else void bestellungUnbezahlt()
  }

  function neueBestellung() {
    setKorb([])
    setTrinkgeldInput('')
    setBestellStatus(null)
    setDemoBestellId('')
    // Bestell-/Abbruch-Parameter aus der URL entfernen
    const url = new URL(window.location.href)
    url.searchParams.delete('bestellung')
    url.searchParams.delete('abbruch')
    window.history.replaceState(null, '', url.toString())
    setPhase('karte')
  }

  // ---------------------------------------------------------------------------
  // Sprachumschalter (wiederverwendbar)
  // ---------------------------------------------------------------------------

  function LangSwitch({ className }: { className?: string }) {
    return (
      <div className={`flex gap-1 ${className ?? ''}`}>
        {LANGS.map(l => (
          <button
            key={l.code}
            onClick={() => switchLang(l.code)}
            className={`px-2 py-1 rounded-lg text-xs font-bold transition ${
              lang === l.code
                ? 'bg-brand-500 text-white'
                : 'text-ink-subtle hover:bg-panel-2'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (phase === 'laden' || phase === 'zahlung') return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-brand-400 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-ink-subtle text-sm">{phase === 'zahlung' ? t.weiterZahlung : t.laden}</p>
      </div>
    </div>
  )

  if (phase === 'status') return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-sm">
        <div className="w-12 h-12 border-4 border-brand-400 border-t-transparent rounded-full animate-spin mx-auto" />
        <h1 className="text-xl font-bold text-ink">{t.zahlungVerarbeitung}</h1>
      </div>
    </div>
  )

  if (phase === 'fehler') return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-sm">
        <div className="text-5xl">⚠️</div>
        <h1 className="text-xl font-bold text-ink">{t.fehlerTitel}</h1>
        <p className="text-ink-subtle text-sm">{fehler}</p>
        <p className="text-ink-subtle text-xs">{t.fehlerHilfe}</p>
        <LangSwitch className="justify-center" />
      </div>
    </div>
  )

  if (phase === 'abbruch') return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="text-center space-y-5 max-w-sm">
        <div className="text-6xl">🚫</div>
        <h1 className="text-xl font-bold text-ink">{t.zahlungAbgebrochen}</h1>
        <p className="text-ink-subtle text-sm">{t.zahlungAbgebrochenText}</p>
        <button
          onClick={neueBestellung}
          className="w-full py-3 rounded-2xl bg-brand-500 text-white font-bold text-sm hover:bg-brand-600 transition"
        >
          {t.zurueckZurKarte}
        </button>
        <LangSwitch className="justify-center" />
      </div>
    </div>
  )

  if (phase === 'beleg' && bestellStatus?.beleg) {
    const b = bestellStatus.beleg.beleg
    return (
      <div className="min-h-screen bg-brand-50 flex flex-col items-center p-6">
        <div className="max-w-sm w-full space-y-5 text-center">
          <div className="text-6xl">✅</div>
          <h1 className="text-2xl font-black text-ink">{t.belegTitel}</h1>
          <p className="text-ink-muted text-sm">{t.belegFertig}</p>
          {tischNummer && (
            <div className="bg-brand-100 rounded-2xl px-6 py-2 inline-block">
              <p className="text-xs text-brand-600 font-medium">{t.deinTisch}</p>
              <p className="text-xl font-black text-brand-800">{tischNummer}</p>
            </div>
          )}

          {/* Beleg */}
          <div className="bg-panel rounded-2xl border border-line p-4 text-left space-y-2">
            <p className="font-black text-ink text-center">{bestellStatus.beleg.firmenname}</p>
            <div className="border-t border-line pt-2 space-y-1">
              {b.positionen.map((p, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-ink">{p.menge}× {p.bezeichnung}</span>
                  <span className="font-mono text-ink-muted">{formatPreis(p.einzelpreisBreutto * p.menge)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-line pt-2 flex justify-between items-center">
              <span className="font-black text-ink">{t.gesamt}</span>
              <span className="font-black text-brand-600 font-mono">{formatPreis(b.gesamtbetragCent)}</span>
            </div>
            <div className="flex justify-center pt-2">
              <QRCodeSVG value={b.maschinenlesbareCode} size={168} />
            </div>
            <p className="text-center text-[11px] text-ink-subtle">{t.belegQrHinweis}</p>
            <p className="text-center text-[11px] text-ink-subtle">
              {t.belegNr} {b.belegNummer} · {new Date(b.belegDatum).toLocaleString()}
            </p>
          </div>

          <button
            onClick={neueBestellung}
            className="w-full py-3 rounded-2xl border-2 border-brand-300 text-brand-700 font-bold text-sm hover:bg-brand-100 transition"
          >
            {t.weitereBestellung}
          </button>
          <LangSwitch className="justify-center" />
        </div>
      </div>
    )
  }

  if (phase === 'danke') return (
    <div className="min-h-screen bg-brand-50 flex items-center justify-center p-6">
      <div className="text-center space-y-5 max-w-sm">
        <div className="text-7xl">🎉</div>
        <h1 className="text-2xl font-black text-ink">{t.dankeTitel}</h1>
        <p className="text-ink-muted">{t.dankeText}</p>
        {tischNummer && (
          <div className="bg-brand-100 rounded-2xl px-6 py-3 inline-block">
            <p className="text-xs text-brand-600 font-medium">{t.deinTisch}</p>
            <p className="text-2xl font-black text-brand-800">{tischNummer}</p>
          </div>
        )}
        <button
          onClick={() => { setKorb([]); setTrinkgeldInput(''); setPhase('karte') }}
          className="w-full py-3 rounded-2xl border-2 border-brand-300 text-brand-700 font-bold text-sm hover:bg-brand-100 transition"
        >
          {t.weitereBestellung}
        </button>
        <LangSwitch className="justify-center" />
      </div>
    </div>
  )

  if (phase === 'bestaetigung') return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="bg-panel border-b border-line px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => setPhase('karte')} className="text-ink-subtle hover:text-ink text-xl">‹</button>
          <h1 className="font-black text-ink text-lg">{t.bestätigenTitel}</h1>
        </div>
        <LangSwitch />
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {tischNummer && (
          <div className="bg-brand-50 rounded-2xl px-4 py-3 flex items-center gap-3">
            <span className="text-2xl">🪑</span>
            <div>
              <p className="text-xs text-brand-600 font-medium">{t.tisch}</p>
              <p className="font-black text-brand-900">{tischNummer}</p>
            </div>
          </div>
        )}
        <div className="bg-panel rounded-2xl border border-line overflow-hidden">
          {korb.map(k => (
            <div key={k.artikel.id} className="flex items-center justify-between px-4 py-3 border-b border-line last:border-0">
              <div className="flex items-center gap-3">
                <span className="bg-brand-100 text-brand-700 font-black text-sm w-7 h-7 rounded-full flex items-center justify-center">
                  {k.menge}
                </span>
                <span className="font-medium text-ink text-sm">{k.artikel.bezeichnung}</span>
              </div>
              <span className="font-mono text-sm text-ink-muted">
                {formatPreis(k.artikel.preisBruttoCent * k.menge)}
              </span>
            </div>
          ))}
        </div>
        {bezahlModus ? (
          <>
            {/* Trinkgeld — freiwillige freie Eingabe */}
            <div className="bg-panel rounded-2xl border border-line px-4 py-3 space-y-2">
              <label htmlFor="trinkgeld" className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-ink text-sm">{t.trinkgeldOptional}</span>
                <span className="text-[11px] text-ink-subtle">{t.trinkgeldHinweis}</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-ink-muted font-bold text-lg">€</span>
                <input
                  id="trinkgeld"
                  type="text"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={trinkgeldInput}
                  onChange={e => setTrinkgeldInput(e.target.value)}
                  className="flex-1 rounded-xl border border-line-strong px-3 py-2 text-right font-mono text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
            </div>

            {/* Summenaufstellung */}
            <div className="bg-panel rounded-2xl border-2 border-brand-200 px-4 py-3 space-y-1">
              <div className="flex justify-between text-sm text-ink-muted">
                <span>{t.zwischensumme}</span>
                <span className="font-mono">{formatPreis(gesamtCent)}</span>
              </div>
              {trinkgeldCent > 0 && (
                <div className="flex justify-between text-sm text-ink-muted">
                  <span>{t.trinkgeld}</span>
                  <span className="font-mono">{formatPreis(trinkgeldCent)}</span>
                </div>
              )}
              <div className="flex justify-between items-center border-t border-line pt-1 mt-1">
                <span className="font-black text-ink">{t.gesamt}</span>
                <span className="font-black text-xl text-brand-600 font-mono">{formatPreis(gesamtMitTrinkgeld)}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="bg-panel rounded-2xl border-2 border-brand-200 px-4 py-3 flex justify-between items-center">
            <span className="font-black text-ink">{t.gesamt}</span>
            <span className="font-black text-xl text-brand-600 font-mono">{formatPreis(gesamtCent)}</span>
          </div>
        )}
      </div>

      <div className="p-4 bg-panel border-t border-line">
        <button
          onClick={() => absenden()}
          disabled={senden}
          className="w-full py-4 rounded-2xl font-black text-lg text-white bg-brand-500 hover:bg-brand-600 active:scale-95 transition disabled:opacity-50"
        >
          {senden ? t.wirdGesendet : (bezahlModus ? t.bestellenZahlen : t.jetztBestellen)}
        </button>
      </div>
    </div>
  )

  // Hauptansicht: Speisekarte
  return (
    <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">

      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-black text-ink text-lg">{karte?.kasse.bezeichnung}</h1>
            {tischNummer && <p className="text-sm text-ink-subtle">{t.tisch}: <span className="font-semibold">{tischNummer}</span></p>}
          </div>
          <div className="flex items-center gap-2">
            <LangSwitch />
            {gesamtMenge > 0 && (
              <button
                onClick={() => setPhase('bestaetigung')}
                className="flex items-center gap-2 bg-brand-500 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition"
              >
                <span className="bg-panel text-brand-600 rounded-full w-5 h-5 flex items-center justify-center text-xs font-black">
                  {gesamtMenge}
                </span>
                {formatPreis(gesamtCent)}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Kategorie-Tabs */}
      {(karte?.kategorien.length ?? 0) > 1 && (
        <div className="bg-panel border-b border-line px-4 overflow-x-auto sticky top-[73px] z-10">
          <div className="flex gap-1 py-2">
            {karte?.kategorien.map(k => (
              <button
                key={k.id}
                onClick={() => setAktivKat(k.id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition ${
                  aktivKat === k.id
                    ? 'bg-brand-500 text-white'
                    : 'text-ink-muted hover:bg-panel-2'
                }`}
              >
                {k.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Artikel-Liste */}
      <div className="flex-1 p-4 space-y-3">
        {artikelInKat.length === 0 ? (
          <div className="text-center py-12 text-ink-subtle text-sm">
            {t.keineArtikel}
          </div>
        ) : (
          artikelInKat.map(a => {
            const menge = mengeVon(a.id)
            return (
              <div key={a.id} className="bg-panel rounded-2xl border border-line px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-ink text-sm leading-tight">{a.bezeichnung}</p>
                  <p className="text-brand-600 font-black text-base mt-0.5">{formatPreis(a.preisBruttoCent)}</p>
                </div>
                {menge === 0 ? (
                  <button
                    onClick={() => aendereMenge(a, 1)}
                    className="w-10 h-10 rounded-xl bg-brand-500 text-white font-black text-xl flex items-center justify-center active:scale-90 transition shrink-0"
                  >+</button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => aendereMenge(a, -1)}
                      className="w-9 h-9 rounded-xl border-2 border-brand-300 text-brand-600 font-black text-xl flex items-center justify-center active:scale-90 transition"
                    >−</button>
                    <span className="w-6 text-center font-black text-ink">{menge}</span>
                    <button
                      onClick={() => aendereMenge(a, 1)}
                      className="w-9 h-9 rounded-xl bg-brand-500 text-white font-black text-xl flex items-center justify-center active:scale-90 transition"
                    >+</button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Sticky Warenkorb-Button */}
      {gesamtMenge > 0 && (
        <div className="p-4 bg-panel border-t border-line sticky bottom-0">
          <button
            onClick={() => setPhase('bestaetigung')}
            className="w-full py-4 rounded-2xl font-black text-lg text-white bg-brand-500 hover:bg-brand-600 active:scale-95 transition flex items-center justify-between px-6"
          >
            <span className="bg-brand-400 rounded-xl px-2 py-0.5 text-sm">
              {(t.artikelAnzahl as (n: number) => string)(gesamtMenge)}
            </span>
            <span>{t.warenkorbAnsehen}</span>
            <span className="font-mono">{formatPreis(gesamtCent)}</span>
          </button>
        </div>
      )}
    </div>
  )
}
