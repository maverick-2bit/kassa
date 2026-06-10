import { useEffect, useMemo, useState } from 'react'
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
  kasse:      { id: string; bezeichnung: string }
  kategorien: GastKategorie[]
  artikel:    GastArtikel[]
}

interface KorbItem {
  artikel:    GastArtikel
  menge:      number
}

type Phase = 'laden' | 'fehler' | 'karte' | 'bestaetigung' | 'danke'

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

function getParams() {
  const p = new URLSearchParams(window.location.search)
  return {
    kasseId:     p.get('kasseId') ?? '',
    tischNummer: p.get('tisch')   ?? p.get('tischNummer') ?? '',
  }
}

function formatPreis(cent: number): string {
  return `€ ${(cent / 100).toFixed(2).replace('.', ',')}`
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
  const { kasseId, tischNummer } = getParams()
  const [phase, setPhase]       = useState<Phase>('laden')
  const [fehler, setFehler]     = useState('')
  const [karte, setKarte]       = useState<Karte | null>(null)
  const [korb, setKorb]         = useState<KorbItem[]>([])
  const [aktivKat, setAktivKat] = useState<string | null>(null)
  const [senden, setSenden]     = useState(false)
  const [lang, setLang]         = useState<Lang>(detectLang)

  const t = TRANSLATIONS[lang]

  function switchLang(l: Lang) {
    setLang(l)
    wechsleLang(l)
  }

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
        setPhase('karte')
      })
      .catch(e => {
        setFehler(e instanceof Error ? e.message : t.fehlerLaden)
        setPhase('fehler')
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kasseId])

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

  const artikelInKat = useMemo(() =>
    karte?.artikel.filter(a => a.kategorieId === aktivKat) ?? [],
    [karte, aktivKat]
  )

  async function bestellung() {
    if (!kasseId || korb.length === 0) return
    setSenden(true)
    try {
      const res = await fetch('/api/gast/bestellung', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kasseId,
          tischNummer: tischNummer || 'Unbekannt',
          positionen:  korb.map(k => ({
            artikelId:       k.artikel.id,
            bezeichnung:     k.artikel.bezeichnung,
            menge:           k.menge,
            preisBruttoCent: k.artikel.preisBruttoCent,
          })),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPhase('danke')
    } catch {
      alert(t.fehlerSenden)
    } finally {
      setSenden(false)
    }
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
                ? 'bg-orange-500 text-white'
                : 'text-gray-500 hover:bg-gray-100'
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

  if (phase === 'laden') return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-orange-400 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-gray-500 text-sm">{t.laden}</p>
      </div>
    </div>
  )

  if (phase === 'fehler') return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-sm">
        <div className="text-5xl">⚠️</div>
        <h1 className="text-xl font-bold text-gray-800">{t.fehlerTitel}</h1>
        <p className="text-gray-500 text-sm">{fehler}</p>
        <p className="text-gray-400 text-xs">{t.fehlerHilfe}</p>
        <LangSwitch className="justify-center" />
      </div>
    </div>
  )

  if (phase === 'danke') return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center p-6">
      <div className="text-center space-y-5 max-w-sm">
        <div className="text-7xl">🎉</div>
        <h1 className="text-2xl font-black text-gray-900">{t.dankeTitel}</h1>
        <p className="text-gray-600">{t.dankeText}</p>
        {tischNummer && (
          <div className="bg-orange-100 rounded-2xl px-6 py-3 inline-block">
            <p className="text-xs text-orange-600 font-medium">{t.deinTisch}</p>
            <p className="text-2xl font-black text-orange-800">{tischNummer}</p>
          </div>
        )}
        <button
          onClick={() => { setKorb([]); setPhase('karte') }}
          className="w-full py-3 rounded-2xl border-2 border-orange-300 text-orange-700 font-bold text-sm hover:bg-orange-100 transition"
        >
          {t.weitereBestellung}
        </button>
        <LangSwitch className="justify-center" />
      </div>
    </div>
  )

  if (phase === 'bestaetigung') return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => setPhase('karte')} className="text-gray-500 hover:text-gray-700 text-xl">‹</button>
          <h1 className="font-black text-gray-900 text-lg">{t.bestätigenTitel}</h1>
        </div>
        <LangSwitch />
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {tischNummer && (
          <div className="bg-orange-50 rounded-2xl px-4 py-3 flex items-center gap-3">
            <span className="text-2xl">🪑</span>
            <div>
              <p className="text-xs text-orange-600 font-medium">{t.tisch}</p>
              <p className="font-black text-orange-900">{tischNummer}</p>
            </div>
          </div>
        )}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {korb.map(k => (
            <div key={k.artikel.id} className="flex items-center justify-between px-4 py-3 border-b border-gray-100 last:border-0">
              <div className="flex items-center gap-3">
                <span className="bg-orange-100 text-orange-700 font-black text-sm w-7 h-7 rounded-full flex items-center justify-center">
                  {k.menge}
                </span>
                <span className="font-medium text-gray-900 text-sm">{k.artikel.bezeichnung}</span>
              </div>
              <span className="font-mono text-sm text-gray-700">
                {formatPreis(k.artikel.preisBruttoCent * k.menge)}
              </span>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border-2 border-orange-200 px-4 py-3 flex justify-between items-center">
          <span className="font-black text-gray-900">{t.gesamt}</span>
          <span className="font-black text-xl text-orange-600 font-mono">{formatPreis(gesamtCent)}</span>
        </div>
      </div>

      <div className="p-4 bg-white border-t border-gray-200">
        <button
          onClick={() => void bestellung()}
          disabled={senden}
          className="w-full py-4 rounded-2xl font-black text-lg text-white bg-orange-500 hover:bg-orange-600 active:scale-95 transition disabled:opacity-50"
        >
          {senden ? t.wirdGesendet : t.jetztBestellen}
        </button>
      </div>
    </div>
  )

  // Hauptansicht: Speisekarte
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-lg mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-black text-gray-900 text-lg">{karte?.kasse.bezeichnung}</h1>
            {tischNummer && <p className="text-sm text-gray-500">{t.tisch}: <span className="font-semibold">{tischNummer}</span></p>}
          </div>
          <div className="flex items-center gap-2">
            <LangSwitch />
            {gesamtMenge > 0 && (
              <button
                onClick={() => setPhase('bestaetigung')}
                className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition"
              >
                <span className="bg-white text-orange-600 rounded-full w-5 h-5 flex items-center justify-center text-xs font-black">
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
        <div className="bg-white border-b border-gray-200 px-4 overflow-x-auto sticky top-[73px] z-10">
          <div className="flex gap-1 py-2">
            {karte?.kategorien.map(k => (
              <button
                key={k.id}
                onClick={() => setAktivKat(k.id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition ${
                  aktivKat === k.id
                    ? 'bg-orange-500 text-white'
                    : 'text-gray-600 hover:bg-gray-100'
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
          <div className="text-center py-12 text-gray-400 text-sm">
            {t.keineArtikel}
          </div>
        ) : (
          artikelInKat.map(a => {
            const menge = mengeVon(a.id)
            return (
              <div key={a.id} className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 text-sm leading-tight">{a.bezeichnung}</p>
                  <p className="text-orange-600 font-black text-base mt-0.5">{formatPreis(a.preisBruttoCent)}</p>
                </div>
                {menge === 0 ? (
                  <button
                    onClick={() => aendereMenge(a, 1)}
                    className="w-10 h-10 rounded-xl bg-orange-500 text-white font-black text-xl flex items-center justify-center active:scale-90 transition shrink-0"
                  >+</button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => aendereMenge(a, -1)}
                      className="w-9 h-9 rounded-xl border-2 border-orange-300 text-orange-600 font-black text-xl flex items-center justify-center active:scale-90 transition"
                    >−</button>
                    <span className="w-6 text-center font-black text-gray-900">{menge}</span>
                    <button
                      onClick={() => aendereMenge(a, 1)}
                      className="w-9 h-9 rounded-xl bg-orange-500 text-white font-black text-xl flex items-center justify-center active:scale-90 transition"
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
        <div className="p-4 bg-white border-t border-gray-200 sticky bottom-0">
          <button
            onClick={() => setPhase('bestaetigung')}
            className="w-full py-4 rounded-2xl font-black text-lg text-white bg-orange-500 hover:bg-orange-600 active:scale-95 transition flex items-center justify-between px-6"
          >
            <span className="bg-orange-400 rounded-xl px-2 py-0.5 text-sm">
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
