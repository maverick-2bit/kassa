import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artikel,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  TabPosition,
  TischTabResponse,
} from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { artikelApi, belegApi, bonierApi, kategorieApi, tischTabApi, zvtApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { BonAnzeige } from '../components/BonAnzeige'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { ArtikelGrid } from '../components/ArtikelGrid'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface KorbPosition {
  artikel: Artikel
  menge:   number
}

// ---------------------------------------------------------------------------
// Haupt-Seite
// ---------------------------------------------------------------------------

export function TischTabPage() {
  const { tabId }   = useParams<{ tabId: string }>()
  const identity    = getKasseIdentity()!
  const navigate    = useNavigate()
  const qc          = useQueryClient()

  // Neu hinzugefügte Artikel (Warenkorb für diese Session)
  const [korb, setKorb]                             = useState<KorbPosition[]>([])
  const [letzterBon, setLetzterBon]                 = useState<BelegResponse | null>(null)
  const [bonierungErgebnis, setBonierungErgebnis]   = useState<BonierungErgebnis | null>(null)
  const [bezahlenOffen, setBezahlenOffen]           = useState(false)
  const [barInput, setBarInput]                     = useState('')
  const [karteInput, setKarteInput]                 = useState('')
  const [fehler, setFehler]                         = useState<string | null>(null)
  const [zvtOffen, setZvtOffen]                     = useState(false)
  const [zvtBetrag, setZvtBetrag]                   = useState(0)

  const zvtCfg = useQuery({
    queryKey: ['zvt', identity.kasseId],
    queryFn:  () => zvtApi.getConfig(identity.kasseId),
  })

  const tabQuery = useQuery({
    queryKey:        ['tisch-tab', tabId],
    queryFn:         () => tischTabApi.get(tabId!),
    enabled:         !!tabId,
    refetchInterval: 5_000,
  })

  const artikelQuery = useQuery({
    queryKey: ['artikel', identity.mandantId, true],
    queryFn:  () => artikelApi.list(identity.mandantId, true),
  })

  const kategorienQuery = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(true),
  })

  const tab = tabQuery.data

  // Alle Positionen (bestehend + Warenkorb) für Gesamtanzeige und Bezahlen
  const allePositionen: TabPosition[] = useMemo(() => {
    if (!tab) return []
    const merged = [...tab.positionen]
    for (const k of korb) {
      const idx = merged.findIndex(p => p.artikelId === k.artikel.id)
      if (idx >= 0) {
        const cur = merged[idx]!
        merged[idx] = { ...cur, menge: cur.menge + k.menge }
      } else {
        merged.push({
          artikelId:       k.artikel.id,
          bezeichnung:     k.artikel.bezeichnung,
          preisBruttoCent: k.artikel.preisBruttoCent,
          menge:           k.menge,
          ...(k.artikel.station ? { station: k.artikel.station } : {}),
        })
      }
    }
    return merged
  }, [tab, korb])

  const korbSummeCent = useMemo(
    () => korb.reduce((s, p) => s + p.artikel.preisBruttoCent * p.menge, 0),
    [korb],
  )
  const gesamt = (tab?.summeGesamtCent ?? 0) + korbSummeCent

  // ---------------------------------------------------------------------------
  // Warenkorb-Aktionen
  // ---------------------------------------------------------------------------

  const addArtikel = (a: Artikel) => {
    setFehler(null)
    setKorb(prev => {
      const ex = prev.find(p => p.artikel.id === a.id)
      if (ex) return prev.map(p => p.artikel.id === a.id ? { ...p, menge: p.menge + 1 } : p)
      return [...prev, { artikel: a, menge: 1 }]
    })
  }

  const updateKorbMenge = (artikelId: string, delta: number) => {
    setKorb(prev =>
      prev.flatMap(p => {
        if (p.artikel.id !== artikelId) return [p]
        const n = p.menge + delta
        return n <= 0 ? [] : [{ ...p, menge: n }]
      }),
    )
  }

  const removeKorbArtikel = (artikelId: string) => {
    setKorb(prev => prev.filter(p => p.artikel.id !== artikelId))
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const speichernMutation = useMutation({
    mutationFn: (positionen: TabPosition[]) =>
      tischTabApi.aktualisierePositionen(tabId!, positionen),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      setKorb([])
      setFehler(null)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const bonierMutation = useMutation({
    mutationFn: (input: BonierungInput) => bonierApi.bonieren(input),
    onSuccess: async (ergebnis) => {
      setBonierungErgebnis(ergebnis)
      // Neuen Korb-Inhalt zum Tab speichern
      await speichernMutation.mutateAsync(allePositionen)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const bezahlenMutation = useMutation({
    mutationFn: async ({ bar, karte }: { bar: number; karte: number }) => {
      // Zuerst aktuelle Positionen speichern (inkl. Warenkorb)
      if (korb.length > 0) {
        await tischTabApi.aktualisierePositionen(tabId!, allePositionen)
      }
      return tischTabApi.bezahle(tabId!, {
        zahlung: { barCent: bar, karteCent: karte, sonstigeCent: 0 },
      })
    },
    onSuccess: async ({ belegId }) => {
      setBezahlenOffen(false)
      const beleg = await belegApi.list(identity.kasseId, 1).then(l => l[0] ?? null)
      if (beleg && beleg.id === belegId) setLetzterBon(beleg)
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      qc.invalidateQueries({ queryKey: ['belege'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // ---------------------------------------------------------------------------
  // Handler
  // ---------------------------------------------------------------------------

  const handleBonieren = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Keine neuen Artikel im Warenkorb.'); return }
    const positionen = korb
      .filter(p => p.artikel.station)
      .map(p => ({ artikelId: p.artikel.id, menge: p.menge }))
    if (positionen.length === 0) { setFehler('Kein Artikel hat eine KDS-Station.'); return }
    bonierMutation.mutate({
      kasseId: identity.kasseId,
      tisch:   tab?.tischNummer ?? '',
      kellner: tab?.kellner ?? '',
      positionen,
    })
  }

  const handleHinzufuegen = () => {
    if (korb.length === 0) return
    speichernMutation.mutate(allePositionen)
  }

  const handleBezahlen = () => {
    setFehler(null)
    setBezahlenOffen(true)
    setBarInput('')
    setKarteInput('')
  }

  const handleBezahlenBestaetigen = () => {
    const bar   = parseInt(barInput   || '0', 10) || 0
    const karte = parseInt(karteInput || '0', 10) || 0
    if (bar + karte !== gesamt) {
      setFehler(`Zahlungssumme passt nicht: ${formatPreis(bar + karte)} statt ${formatPreis(gesamt)}`)
      return
    }

    // Kartenzahlung mit aktiviertem ZVT → erst Terminal, dann Beleg
    if (karte > 0 && zvtCfg.data?.zvtAktiv) {
      setBezahlenOffen(false)
      setZvtBetrag(karte)
      setZvtOffen(true)
      return
    }

    bezahlenMutation.mutate({ bar, karte })
  }

  const handleBonGeschlossen = () => {
    setLetzterBon(null)
    navigate('/tische')
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  if (tabQuery.isLoading) return <p className="p-6 text-sm text-gray-500">Wird geladen…</p>
  if (!tab) return <p className="p-6 text-sm text-red-600">Tisch-Tab nicht gefunden.</p>

  return (
    <div className="mx-auto max-w-7xl px-4 py-4">
      {/* Kopfzeile */}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/tische')}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          ← Tische
        </button>
        <div className="h-4 w-px bg-gray-300" />
        <h1 className="text-lg font-semibold text-gray-900">
          Tisch {tab.tischNummer}
        </h1>
        <span className="text-sm text-gray-500">· {tab.kellner}</span>
        <span className="ml-auto text-xs text-gray-400">
          Geöffnet {new Date(tab.geoffnetAm).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })} Uhr
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* Linke Seite: Artikel-Buttons */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Artikel nachbestellen</h2>
          <ArtikelGrid
            artikel={artikelQuery.data ?? []}
            kategorien={kategorienQuery.data ?? []}
            onArtikelClick={addArtikel}
            loading={artikelQuery.isLoading}
          />
        </section>

        {/* Rechte Seite: Tab + Warenkorb */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-fit lg:sticky lg:top-20 max-h-[calc(100vh-6rem)]">
          {/* Bestehende Positionen */}
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">Laufende Bestellung</h2>
          </div>
          <div className="overflow-y-auto flex-1 px-4 py-3 max-h-[30vh]">
            {tab.positionen.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">Noch keine Positionen.</p>
            ) : (
              <ul className="space-y-1.5">
                {tab.positionen.map((p, i) => (
                  <li key={i} className="flex justify-between text-sm">
                    <span className="text-gray-800 flex-1">
                      {p.menge}× {p.bezeichnung}
                    </span>
                    <span className="font-mono text-gray-700 ml-2 shrink-0">
                      {formatPreis(p.preisBruttoCent * p.menge)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Neuer Warenkorb */}
          {korb.length > 0 && (
            <>
              <div className="px-4 py-2 bg-amber-50 border-y border-amber-200">
                <p className="text-xs font-semibold text-amber-700">Neu (noch nicht gespeichert)</p>
              </div>
              <div className="px-4 py-3 max-h-[25vh] overflow-y-auto">
                <ul className="space-y-1.5">
                  {korb.map((p) => (
                    <li key={p.artikel.id} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">{p.artikel.bezeichnung}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <MengeButton onClick={() => updateKorbMenge(p.artikel.id, -1)}>−</MengeButton>
                        <span className="w-5 text-center text-xs font-medium">{p.menge}</span>
                        <MengeButton onClick={() => updateKorbMenge(p.artikel.id, +1)}>+</MengeButton>
                      </div>
                      <span className="w-18 text-right font-mono text-xs shrink-0">
                        {formatPreis(p.artikel.preisBruttoCent * p.menge)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeKorbArtikel(p.artikel.id)}
                        className="text-gray-300 hover:text-red-500 px-1"
                      >×</button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {/* Aktionsbereich */}
          <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 space-y-3">
            <div className="flex items-center justify-between text-base font-bold text-gray-900">
              <span>Gesamt</span>
              <span>{formatPreis(gesamt)}</span>
            </div>

            {fehler && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
            )}

            {/* Warenkorb-Aktionen */}
            {korb.length > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={handleBonieren}
                  loading={bonierMutation.isPending}
                  className="flex-1 text-xs"
                >
                  Bonieren + Speichern
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleHinzufuegen}
                  loading={speichernMutation.isPending}
                  className="flex-1 text-xs"
                >
                  Nur speichern
                </Button>
              </div>
            )}

            <Button
              onClick={handleBezahlen}
              className="w-full"
              disabled={gesamt === 0}
            >
              Bezahlen ({formatPreis(gesamt)})
            </Button>
          </div>
        </section>
      </div>

      {/* Bezahlen-Modal */}
      <Modal
        open={bezahlenOffen}
        onClose={() => setBezahlenOffen(false)}
        title={`Tisch ${tab.tischNummer} bezahlen`}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Gesamt: <strong>{formatPreis(gesamt)}</strong>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Bar (Cent)</span>
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="0"
                value={barInput}
                onChange={(e) => setBarInput(e.target.value.replace(/[^0-9]/g, ''))}
                className="mt-0.5"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Karte (Cent)</span>
              <Input
                inputMode="numeric"
                placeholder="0"
                value={karteInput}
                onChange={(e) => setKarteInput(e.target.value.replace(/[^0-9]/g, ''))}
                className="mt-0.5"
              />
            </label>
          </div>
          <p className="text-xs text-gray-500">
            Schnellbuttons:&nbsp;
            <button type="button" onClick={() => { setBarInput(String(gesamt)); setKarteInput('') }} className="text-brand-600 hover:underline">Bar = Gesamt</button>
            {' · '}
            <button type="button" onClick={() => { setKarteInput(String(gesamt)); setBarInput('') }} className="text-brand-600 hover:underline">Karte = Gesamt</button>
          </p>
          {fehler && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
          )}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => setBezahlenOffen(false)} className="flex-1">
              Abbrechen
            </Button>
            <Button
              onClick={handleBezahlenBestaetigen}
              loading={bezahlenMutation.isPending}
              className="flex-1"
            >
              Bon erstellen
            </Button>
          </div>
        </div>
      </Modal>

      {/* Bon-Anzeige nach Bezahlen */}
      <Modal
        open={!!letzterBon}
        onClose={handleBonGeschlossen}
        title={`Beleg #${letzterBon?.belegNummer} erstellt`}
        size="lg"
      >
        {letzterBon && <BonAnzeige beleg={letzterBon} />}
      </Modal>

      {/* Bonierungs-Ergebnis */}
      <Modal
        open={!!bonierungErgebnis}
        onClose={() => setBonierungErgebnis(null)}
        title={`Bonierung ${bonierungErgebnis?.bonNummer ?? ''}`}
      >
        {bonierungErgebnis && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Bonierbons an folgende Stationen gesendet:</p>
            <ul className="space-y-1.5">
              {bonierungErgebnis.stationen.map((s) => (
                <li
                  key={s.station}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                    s.erfolgreich
                      ? 'border-green-200 bg-green-50 text-green-800'
                      : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                >
                  <span className="font-medium">
                    {STATION_LABELS[s.station]}{' '}
                    <span className="font-mono text-xs text-gray-500">({s.ip || '—'})</span>
                  </span>
                  <span>
                    {s.erfolgreich
                      ? `${s.positionen} Position${s.positionen === 1 ? '' : 'en'}`
                      : s.fehler ?? 'Fehler'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {/* Kartenzahlung (ZVT) — vor Beleg-Erstellung */}
      <KartenzahlungModal
        open={zvtOffen}
        kasseId={identity.kasseId}
        betragCent={zvtBetrag}
        onErfolg={() => {
          setZvtOffen(false)
          const bar   = parseInt(barInput   || '0', 10) || 0
          const karte = parseInt(karteInput || '0', 10) || 0
          bezahlenMutation.mutate({ bar, karte })
        }}
        onAbbruch={() => {
          setZvtOffen(false)
          setBezahlenOffen(true)
          setFehler('Kartenzahlung abgebrochen — kein Beleg erstellt')
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kleine Bausteine
// ---------------------------------------------------------------------------

function MengeButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-5 w-5 rounded border border-gray-300 bg-white text-xs font-bold text-gray-700 hover:bg-gray-100"
    >
      {children}
    </button>
  )
}
