import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artikel,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  ModifikatorAuswahl,
  ModifikatorGruppe,
  RabattInput,
  TabEreignis,
  TabPosition,
  TischTabSplittenInput,
  TischTabResponse,
} from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { artikelApi, belegApi, bonierApi, kategorieApi, modifikatorApi, posConfigApi, tischTabApi, zvtApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { BonAnzeige } from '../components/BonAnzeige'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { RabattModal } from '../components/RabattModal'
import { ArtikelGrid } from '../components/ArtikelGrid'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface KorbPosition {
  artikel:       Artikel
  menge:         number
  modifikatoren: ModifikatorAuswahl[]
  preisCent:     number
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
  const [rabatt, setRabatt]                         = useState<RabattInput | null>(null)
  const [rabattOffen, setRabattOffen]               = useState(false)
  const [posRabatteOffen, setPosRabatteOffen]       = useState(false)
  /** positionIndex → neuer Einzelpreis in Cent */
  const [posRabatte, setPosRabatte]                 = useState<Record<number, number>>({})
  const [barInput, setBarInput]                     = useState('')
  const [karteInput, setKarteInput]                 = useState('')
  const [fehler, setFehler]                         = useState<string | null>(null)
  const [zvtOffen, setZvtOffen]                     = useState(false)
  const [zvtBetrag, setZvtBetrag]                   = useState(0)
  const [umbuchenOffen, setUmbuchenOffen]           = useState(false)
  const [umbenennenOffen, setUmbenennenOffen]       = useState(false)
  const [splitOffen, setSplitOffen]                 = useState(false)
  const [verlaufOffen, setVerlaufOffen]             = useState(false)

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

  const modGruppenQuery = useQuery({
    queryKey: ['modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeGruppen(),
  })

  const modZuweisungenQuery = useQuery({
    queryKey: ['artikel-modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeArtikelZuweisungen(),
  })

  const posConfigQuery = useQuery({
    queryKey: ['pos-config', identity.kasseId],
    queryFn:  () => posConfigApi.get(identity.kasseId),
  })

  const artikelGruppenMap = useMemo<Map<string, ModifikatorGruppe[]>>(() => {
    const gruppen     = modGruppenQuery.data ?? []
    const zuweisungen = modZuweisungenQuery.data ?? []
    const gruppeById  = new Map(gruppen.map(g => [g.id, g]))
    const map = new Map<string, ModifikatorGruppe[]>()
    for (const z of zuweisungen) {
      const gruppe = gruppeById.get(z.gruppeId)
      if (!gruppe || !gruppe.aktiv) continue
      if (!gruppe.modifikatoren.some(m => m.aktiv)) continue
      const list = map.get(z.artikelId) ?? []
      list.push(gruppe)
      map.set(z.artikelId, list)
    }
    return map
  }, [modGruppenQuery.data, modZuweisungenQuery.data])

  const tab = tabQuery.data

  // Alle Positionen (bestehend + Warenkorb) für Gesamtanzeige und Bezahlen
  const allePositionen: TabPosition[] = useMemo(() => {
    if (!tab) return []
    const merged = [...tab.positionen]
    for (const k of korb) {
      // Artikel ohne Modifikatoren: zu bestehender Position addieren
      if (k.modifikatoren.length === 0) {
        const idx = merged.findIndex(
          p => p.artikelId === k.artikel.id && (!p.modifikatoren || p.modifikatoren.length === 0),
        )
        if (idx >= 0) {
          const cur = merged[idx]!
          merged[idx] = { ...cur, menge: cur.menge + k.menge }
          continue
        }
      }
      // Neue Zeile (oder mit Modifikatoren immer neue Zeile)
      const bezeichnungZusatz = k.modifikatoren.length > 0
        ? `${k.artikel.bezeichnung} (${k.modifikatoren.map(m => m.name).join(', ')})`
        : k.artikel.bezeichnung
      merged.push({
        artikelId:       k.artikel.id,
        bezeichnung:     bezeichnungZusatz,
        preisBruttoCent: k.preisCent,
        menge:           k.menge,
        ...(k.artikel.station ? { station: k.artikel.station } : {}),
        ...(k.modifikatoren.length > 0 ? { modifikatoren: k.modifikatoren } : {}),
      })
    }
    return merged
  }, [tab, korb])

  const korbSummeCent = useMemo(
    () => korb.reduce((s, p) => s + p.preisCent * p.menge, 0),
    [korb],
  )

  // Tab-Summe mit Positions-Rabatten
  const tabSummeMitPosRabatten = useMemo(() => {
    if (!tab) return 0
    return tab.positionen.reduce(
      (s, p, i) => s + (posRabatte[i] ?? p.preisBruttoCent) * p.menge, 0
    )
  }, [tab, posRabatte])

  const gesamtVorRabatt = tabSummeMitPosRabatten + korbSummeCent
  const rabattCent = useMemo(() => {
    if (!rabatt || gesamtVorRabatt === 0) return 0
    if (rabatt.typ === 'prozent') return Math.round(gesamtVorRabatt * rabatt.prozent / 100)
    return Math.min(rabatt.betragCent, gesamtVorRabatt)
  }, [rabatt, gesamtVorRabatt])
  const gesamt = gesamtVorRabatt - rabattCent

  // ---------------------------------------------------------------------------
  // Warenkorb-Aktionen
  // ---------------------------------------------------------------------------

  const addArtikel = (a: Artikel, modifikatoren: ModifikatorAuswahl[]) => {
    setFehler(null)
    const aufschlag = modifikatoren.reduce((s, m) => s + m.aufschlagCent, 0)
    const preisCent = a.preisBruttoCent + aufschlag
    setKorb(prev => {
      // Ohne Modifikatoren: bestehende Zeile erhöhen
      if (modifikatoren.length === 0) {
        const ex = prev.find(p => p.artikel.id === a.id && p.modifikatoren.length === 0)
        if (ex) return prev.map(p =>
          p.artikel.id === a.id && p.modifikatoren.length === 0 ? { ...p, menge: p.menge + 1 } : p,
        )
      }
      return [...prev, { artikel: a, menge: 1, modifikatoren, preisCent }]
    })
  }

  const updateKorbMenge = (idx: number, delta: number) => {
    setKorb(prev =>
      prev.flatMap((p, i) => {
        if (i !== idx) return [p]
        const n = p.menge + delta
        return n <= 0 ? [] : [{ ...p, menge: n }]
      }),
    )
  }

  const removeKorbArtikel = (idx: number) => {
    setKorb(prev => prev.filter((_, i) => i !== idx))
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
      // Artikel neu laden, damit dekrementierte Restbestände sofort sichtbar sind
      qc.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const bezahlenMutation = useMutation({
    mutationFn: async ({ bar, karte, trinkgeldCent = 0 }: { bar: number; karte: number; trinkgeldCent?: number }) => {
      if (korb.length > 0) {
        await tischTabApi.aktualisierePositionen(tabId!, allePositionen)
      }
      const posRabatteArr = Object.entries(posRabatte)
        .map(([i, preis]) => ({ positionIndex: Number(i), einzelpreisBreuttoCent: preis }))
      return tischTabApi.bezahle(tabId!, {
        zahlung: { barCent: bar, karteCent: karte, sonstigeCent: 0 },
        ...(rabatt && { rabatt }),
        ...(posRabatteArr.length > 0 && { positionRabatte: posRabatteArr }),
        ...(trinkgeldCent > 0 && { trinkgeldCent }),
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

  const umbenennenMutation = useMutation({
    mutationFn: (kellner: string) => tischTabApi.umbennene(tabId!, kellner),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setUmbenennenOffen(false)
      setFehler(null)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const umbuchenMutation = useMutation({
    mutationFn: (tischNummer: string) => tischTabApi.umbucheTisch(tabId!, tischNummer),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setUmbuchenOffen(false)
      setFehler(null)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const splitMutation = useMutation({
    mutationFn: (input: TischTabSplittenInput) => tischTabApi.splitteUndBezahle(tabId!, input),
    onSuccess: () => {
      setSplitOffen(false)
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      qc.invalidateQueries({ queryKey: ['belege'] })
      navigate('/tische')
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // ---------------------------------------------------------------------------
  // Handler
  // ---------------------------------------------------------------------------

  const handleBonieren = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Keine neuen Artikel im Warenkorb.'); return }
    // Alle Positionen senden — Server entscheidet über KDS- und Bonierdrucker-Routing
    bonierMutation.mutate({
      kasseId:    identity.kasseId,
      tabId:      tabId,
      tisch:      tab?.tischNummer ?? '',
      kellner:    tab?.kellner ?? '',
      positionen: korb.map(p => ({ artikelId: p.artikel.id, menge: p.menge })),
    })
  }

  const handleHinzufuegen = () => {
    if (korb.length === 0) return
    speichernMutation.mutate(allePositionen)
  }

  const handleBezahlen = () => {
    setFehler(null)
    setRabatt(null)
    setBezahlenOffen(true)
    setBarInput('')
    setKarteInput('')
  }

  const handlePosRabatteBestaetigen = (neuePosRabatte: Record<number, number>) => {
    setPosRabatte(neuePosRabatte)
    setPosRabatteOffen(false)
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
        <button
          type="button"
          onClick={() => { setFehler(null); setUmbenennenOffen(true) }}
          className="group flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
          title="Partei umbenennen"
        >
          · {tab.kellner}
          <svg className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 transition-opacity" viewBox="0 0 20 20" fill="currentColor">
            <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
          </svg>
        </button>
        <span className="text-xs text-gray-400">
          Geöffnet {new Date(tab.geoffnetAm).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })} Uhr
        </span>
        <button
          type="button"
          onClick={() => setVerlaufOffen(true)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm1-12a1 1 0 1 0-2 0v4a1 1 0 0 0 .293.707l2.828 2.829a1 1 0 1 0 1.415-1.415L11 9.586V6z" clipRule="evenodd"/>
          </svg>
          Verlauf
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* Linke Seite: Artikel-Buttons */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200
                            flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <div className="px-4 pt-4 pb-2 shrink-0">
            <h2 className="text-sm font-semibold text-gray-700">Artikel nachbestellen</h2>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
            <ArtikelGrid
              artikel={artikelQuery.data ?? []}
              kategorien={kategorienQuery.data ?? []}
              artikelGruppen={artikelGruppenMap}
              onArtikelClick={addArtikel}
              loading={artikelQuery.isLoading}
              artikelbilderAktiv={posConfigQuery.data?.artikelbilderAktiv ?? true}
            />
          </div>
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
                  {korb.map((p, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">{p.artikel.bezeichnung}</p>
                        {p.modifikatoren.length > 0 && (
                          <p className="text-xs text-brand-600 truncate">
                            {p.modifikatoren.map(m => m.name).join(', ')}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <MengeButton onClick={() => updateKorbMenge(idx, -1)}>−</MengeButton>
                        <span className="w-5 text-center text-xs font-medium">{p.menge}</span>
                        <MengeButton onClick={() => updateKorbMenge(idx, +1)}>+</MengeButton>
                      </div>
                      <span className="w-18 text-right font-mono text-xs shrink-0">
                        {formatPreis(p.preisCent * p.menge)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeKorbArtikel(idx)}
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

            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => { setFehler(null); setUmbuchenOffen(true) }}
                className="flex-1 text-xs"
              >
                ⇄ Tisch wechseln
              </Button>
              <Button
                variant="secondary"
                onClick={() => { setFehler(null); setSplitOffen(true) }}
                className="flex-1 text-xs"
                disabled={tab.positionen.length === 0}
              >
                ⊢ Rechnung teilen
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => { setFehler(null); setPosRabatteOffen(true) }}
                className="flex-1 text-xs"
                disabled={tab.positionen.length === 0}
              >
                {Object.keys(posRabatte).length > 0
                  ? `% Artikel-Rabatte (${Object.keys(posRabatte).length})`
                  : '% Artikel-Rabatte'}
              </Button>
            </div>
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
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>Zwischensumme</span>
            <span>{formatPreis(gesamtVorRabatt)}</span>
          </div>

          {/* Rabatt im Bezahlen-Modal */}
          {rabatt ? (
            <div className="flex items-center justify-between text-sm text-green-700 bg-green-50 rounded px-2 py-1.5 border border-green-200">
              <span className="flex items-center gap-1.5">
                {rabatt.typ === 'prozent'
                  ? `${rabatt.bezeichnung ?? 'Rabatt'} (${rabatt.prozent}%)`
                  : (rabatt.bezeichnung ?? 'Rabatt')}
                <button type="button" onClick={() => setRabatt(null)} className="text-green-500 hover:text-red-500 text-xs px-1">×</button>
              </span>
              <span className="font-mono font-medium">−{formatPreis(rabattCent)}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setRabattOffen(true)}
              className="text-xs text-brand-600 hover:underline font-medium"
            >
              + Rabatt hinzufügen
            </button>
          )}

          <div className="flex items-center justify-between text-base font-bold text-gray-900">
            <span>Zu zahlen</span>
            <span>{formatPreis(gesamt)}</span>
          </div>

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

      <RabattModal
        open={rabattOffen}
        summeCent={gesamtVorRabatt}
        onSubmit={(r) => { setRabatt(r); setRabattOffen(false) }}
        onClose={() => setRabattOffen(false)}
      />

      <ArtikelRabatteModal
        open={posRabatteOffen}
        positionen={tab.positionen}
        posRabatte={posRabatte}
        onBestaetigen={handlePosRabatteBestaetigen}
        onClose={() => setPosRabatteOffen(false)}
      />

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
          <div className="space-y-4">
            {bonierungErgebnis.stationen.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">KDS-Stationen</p>
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
                        <span className="font-mono text-xs opacity-60">({s.ip || '—'})</span>
                      </span>
                      <span>
                        {s.erfolgreich ? `${s.positionen} Pos.` : s.fehler ?? 'Fehler'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bonierungErgebnis.drucker.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Bonierdrucker</p>
                <ul className="space-y-1.5">
                  {bonierungErgebnis.drucker.map((d) => (
                    <li
                      key={d.druckerId}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                        d.erfolgreich
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-red-200 bg-red-50 text-red-700'
                      }`}
                    >
                      <span className="font-medium">
                        {d.name}
                        {d.istBackup && <span className="ml-1.5 text-[10px] rounded-full bg-black/10 px-1.5 py-0.5">Backup</span>}
                        {' '}<span className="font-mono text-xs opacity-60">({d.ip})</span>
                      </span>
                      <span>
                        {d.erfolgreich ? `${d.positionen} Pos.` : d.fehler ?? 'Fehler'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bonierungErgebnis.stationen.length === 0 && bonierungErgebnis.drucker.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-2">Keine Stationen oder Drucker konfiguriert.</p>
            )}
          </div>
        )}
      </Modal>

      {/* Bonierverlauf */}
      <VerlaufModal
        open={verlaufOffen}
        tabId={tabId!}
        tischNummer={tab.tischNummer}
        onClose={() => setVerlaufOffen(false)}
      />

      {/* Partei umbenennen */}
      <UmbenennenModal
        open={umbenennenOffen}
        aktuellerName={tab.kellner}
        loading={umbenennenMutation.isPending}
        fehler={fehler}
        onSubmit={(k) => { setFehler(null); umbenennenMutation.mutate(k) }}
        onClose={() => { setUmbenennenOffen(false); setFehler(null) }}
      />

      {/* Tisch-Umbuchung */}
      <UmbuchenModal
        open={umbuchenOffen}
        aktuellerTisch={tab.tischNummer}
        loading={umbuchenMutation.isPending}
        fehler={fehler}
        onSubmit={(t) => { setFehler(null); umbuchenMutation.mutate(t) }}
        onClose={() => { setUmbuchenOffen(false); setFehler(null) }}
      />

      {/* Rechnung-Split */}
      <SplitModal
        open={splitOffen}
        tab={tab}
        loading={splitMutation.isPending}
        fehler={fehler}
        onSubmit={(input) => { setFehler(null); splitMutation.mutate(input) }}
        onClose={() => { setSplitOffen(false); setFehler(null) }}
      />

      {/* Kartenzahlung (ZVT) — vor Beleg-Erstellung */}
      <KartenzahlungModal
        open={zvtOffen}
        kasseId={identity.kasseId}
        betragCent={zvtBetrag}
        onErfolg={(_job, trinkgeldCent) => {
          setZvtOffen(false)
          const bar   = parseInt(barInput   || '0', 10) || 0
          const karte = parseInt(karteInput || '0', 10) || 0
          bezahlenMutation.mutate({ bar, karte, trinkgeldCent })
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

// ---------------------------------------------------------------------------
// Bonierverlauf Modal
// ---------------------------------------------------------------------------

const EREIGNIS_CONFIG: Record<TabEreignis['typ'], { label: string; icon: string; color: string }> = {
  geoeffnet:               { label: 'Tisch geöffnet',        icon: '🟢', color: 'text-green-700  bg-green-50  border-green-200'  },
  bonierung:               { label: 'Boniert',               icon: '🍽',  color: 'text-blue-700   bg-blue-50   border-blue-200'   },
  positionen_aktualisiert: { label: 'Positionen gespeichert',icon: '📝', color: 'text-gray-700   bg-gray-50   border-gray-200'   },
  storno:                  { label: 'Storno',                icon: '✕',  color: 'text-red-700    bg-red-50    border-red-300'    },
  tisch_gewechselt:        { label: 'Tisch gewechselt',      icon: '⇄',  color: 'text-amber-700  bg-amber-50  border-amber-200'  },
  kellner_umbenannt:       { label: 'Partei umbenannt',      icon: '✏',  color: 'text-amber-700  bg-amber-50  border-amber-200'  },
  bezahlt:                 { label: 'Bezahlt',               icon: '✓',  color: 'text-green-700  bg-green-50  border-green-200'  },
  gesplittet:              { label: 'Rechnung geteilt',      icon: '⊢',  color: 'text-purple-700 bg-purple-50 border-purple-200' },
}

function EreignisDetails({ typ, details }: { typ: TabEreignis['typ']; details: Record<string, unknown> }) {
  switch (typ) {
    case 'geoeffnet':
      return <span>Tisch <strong>{String(details.tischNummer)}</strong> · {String(details.kellner)}</span>

    case 'bonierung': {
      const pos = (details.positionen as Array<{ bezeichnung: string; menge: number }>) ?? []
      const st  = (details.stationen  as Array<{ station: string; erfolgreich: boolean }>) ?? []
      const ok  = st.filter(s => s.erfolgreich).length
      return (
        <span>
          Bon <strong>{String(details.bonNummer)}</strong> ·{' '}
          {pos.map(p => `${p.menge}× ${p.bezeichnung}`).join(', ')}
          {' '}·{' '}
          <span className={ok === st.length ? 'text-green-600' : 'text-red-600'}>
            {ok}/{st.length} Stationen OK
          </span>
        </span>
      )
    }

    case 'positionen_aktualisiert': {
      const pos = (details.positionen as Array<{ bezeichnung: string; menge: number }>) ?? []
      return <span>{pos.map(p => `${p.menge}× ${p.bezeichnung}`).join(', ') || '—'}</span>
    }

    case 'storno': {
      const pos = (details.positionen as Array<{ bezeichnung: string; menge: number; preisBruttoCent: number }>) ?? []
      const summe = pos.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
      return (
        <span>
          {pos.map(p => `${p.menge}× ${p.bezeichnung}`).join(', ')}
          {' '}· <strong>−{formatPreis(summe)}</strong>
        </span>
      )
    }

    case 'tisch_gewechselt':
      return <span>Tisch <strong>{String(details.von)}</strong> → <strong>{String(details.nach)}</strong></span>

    case 'kellner_umbenannt':
      return <span><strong>{String(details.von)}</strong> → <strong>{String(details.nach)}</strong></span>

    case 'bezahlt':
      return (
        <span>
          {formatPreis(Number(details.gesamtCent))} ·{' '}
          {Number(details.barCent) > 0   && `Bar ${formatPreis(Number(details.barCent))} `}
          {Number(details.karteCent) > 0 && `Karte ${formatPreis(Number(details.karteCent))}`}
        </span>
      )

    case 'gesplittet':
      return (
        <span>
          {Number(details.anzahlZahler)} Zahler · {formatPreis(Number(details.gesamtCent))}
        </span>
      )

    default:
      return null
  }
}

interface VerlaufModalProps {
  open:        boolean
  tabId:       string
  tischNummer: string
  onClose:     () => void
}

function VerlaufModal({ open, tabId, tischNummer, onClose }: VerlaufModalProps) {
  const verlaufQuery = useQuery({
    queryKey: ['tab-verlauf', tabId],
    queryFn:  () => tischTabApi.getVerlauf(tabId),
    enabled:  open,
    refetchInterval: open ? 10_000 : false,
  })

  return (
    <Modal open={open} onClose={onClose} title={`Verlauf — Tisch ${tischNummer}`} size="lg">
      {verlaufQuery.isLoading && (
        <p className="text-sm text-gray-500 py-4 text-center">Wird geladen…</p>
      )}
      {verlaufQuery.isError && (
        <p className="text-sm text-red-600 py-4 text-center">Fehler beim Laden.</p>
      )}
      {verlaufQuery.data && verlaufQuery.data.length === 0 && (
        <p className="text-sm text-gray-400 py-4 text-center">Noch keine Einträge.</p>
      )}
      {verlaufQuery.data && verlaufQuery.data.length > 0 && (
        <ol className="space-y-2">
          {verlaufQuery.data.map((e) => {
            const cfg = EREIGNIS_CONFIG[e.typ]
            const ts  = new Date(e.createdAt)
            return (
              <li
                key={e.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${cfg.color}`}
              >
                <span className="text-base leading-none mt-0.5 shrink-0">{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="font-semibold">{cfg.label}</span>
                    <span className="text-xs opacity-60 shrink-0">
                      {ts.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      {' '}
                      {ts.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs opacity-80 break-words">
                    <EreignisDetails typ={e.typ} details={e.details} />
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Partei umbenennen Modal
// ---------------------------------------------------------------------------

interface UmbenennenModalProps {
  open:           boolean
  aktuellerName:  string
  loading:        boolean
  fehler:         string | null
  onSubmit:       (kellner: string) => void
  onClose:        () => void
}

function UmbenennenModal({ open, aktuellerName, loading, fehler, onSubmit, onClose }: UmbenennenModalProps) {
  const [name, setName] = useState(aktuellerName)

  useEffect(() => { if (open) setName(aktuellerName) }, [open, aktuellerName])

  return (
    <Modal open={open} onClose={onClose} title="Partei umbenennen">
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Name / Kellner</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit(name.trim())}
            className="mt-1"
          />
        </label>
        {fehler && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button
            onClick={() => name.trim() && onSubmit(name.trim())}
            loading={loading}
            className="flex-1"
            disabled={!name.trim() || name.trim() === aktuellerName}
          >
            Speichern
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Tisch-Umbuchung Modal
// ---------------------------------------------------------------------------

interface UmbuchenModalProps {
  open:             boolean
  aktuellerTisch:   string
  loading:          boolean
  fehler:           string | null
  onSubmit:         (tischNummer: string) => void
  onClose:          () => void
}

function UmbuchenModal({ open, aktuellerTisch, loading, fehler, onSubmit, onClose }: UmbuchenModalProps) {
  const [neuerTisch, setNeuerTisch] = useState(aktuellerTisch)

  return (
    <Modal open={open} onClose={onClose} title="Tisch wechseln">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Aktueller Tisch: <strong>{aktuellerTisch}</strong>
        </p>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Neuer Tisch</span>
          <Input
            autoFocus
            value={neuerTisch}
            onChange={(e) => setNeuerTisch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && neuerTisch.trim() && onSubmit(neuerTisch.trim())}
            placeholder="z. B. 5, Terrasse 2 …"
            className="mt-1"
          />
        </label>
        {fehler && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button
            onClick={() => neuerTisch.trim() && onSubmit(neuerTisch.trim())}
            loading={loading}
            className="flex-1"
            disabled={!neuerTisch.trim() || neuerTisch.trim() === aktuellerTisch}
          >
            Umbuchen
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Rechnung-Split Modal
// ---------------------------------------------------------------------------

interface SplitZahler {
  id:       number
  mengen:   Record<number, number>   // positionsIndex → zugewiesene Menge
  barInput: string
  karte:    string
}

interface SplitModalProps {
  open:     boolean
  tab:      TischTabResponse
  loading:  boolean
  fehler:   string | null
  onSubmit: (input: TischTabSplittenInput) => void
  onClose:  () => void
}

function initZahler(positionen: TabPosition[], count: number): SplitZahler[] {
  return Array.from({ length: count }, (_, i) => ({
    id:       i,
    mengen:   Object.fromEntries(
      positionen.map((_, posIdx) => [posIdx, i === 0 ? positionen[posIdx]!.menge : 0]),
    ),
    barInput: '',
    karte:    '',
  }))
}

function SplitModal({ open, tab, loading, fehler, onSubmit, onClose }: SplitModalProps) {
  const [zahler, setZahler] = useState<SplitZahler[]>(() => initZahler(tab.positionen, 2))

  // Reset whenever modal opens
  useEffect(() => {
    if (open) setZahler(initZahler(tab.positionen, 2))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const addZahler = () => {
    setZahler(prev => [
      ...prev,
      {
        id:       prev.length,
        mengen:   Object.fromEntries(tab.positionen.map((_, i) => [i, 0])),
        barInput: '',
        karte:    '',
      },
    ])
  }

  const updateMenge = (zahlerId: number, posIdx: number, delta: number) => {
    setZahler(prev => prev.map(z => {
      if (z.id !== zahlerId) return z
      const neu = Math.max(0, (z.mengen[posIdx] ?? 0) + delta)
      return { ...z, mengen: { ...z.mengen, [posIdx]: neu } }
    }))
  }

  const updateBar  = (zahlerId: number, val: string) =>
    setZahler(prev => prev.map(z => z.id === zahlerId ? { ...z, barInput: val.replace(/[^0-9]/g, '') } : z))
  const updateKarte = (zahlerId: number, val: string) =>
    setZahler(prev => prev.map(z => z.id === zahlerId ? { ...z, karte: val.replace(/[^0-9]/g, '') } : z))

  // Validation
  const positionsfehler: string[] = []
  for (const [posIdx, p] of tab.positionen.entries()) {
    const zugewiesen = zahler.reduce((s, z) => s + (z.mengen[posIdx] ?? 0), 0)
    if (zugewiesen !== p.menge) {
      positionsfehler.push(`${p.bezeichnung}: ${zugewiesen} von ${p.menge} zugewiesen`)
    }
  }

  const zahlungsfehler: string[] = []
  const zahlungenMitPositionen = zahler.filter(z =>
    tab.positionen.some((_, i) => (z.mengen[i] ?? 0) > 0)
  )
  for (const z of zahlungenMitPositionen) {
    const subtotal = tab.positionen.reduce(
      (s, p, i) => s + p.preisBruttoCent * (z.mengen[i] ?? 0), 0
    )
    const bar   = parseInt(z.barInput || '0', 10) || 0
    const karte = parseInt(z.karte   || '0', 10) || 0
    if (bar + karte !== subtotal) {
      zahlungsfehler.push(`Zahler ${zahler.indexOf(z) + 1}: ${formatPreis(bar + karte)} statt ${formatPreis(subtotal)}`)
    }
  }

  const kannSubmit = positionsfehler.length === 0 && zahlungsfehler.length === 0 && zahlungenMitPositionen.length >= 2

  const handleSubmit = () => {
    const zahlungen = zahlungenMitPositionen.map(z => ({
      positionen: tab.positionen
        .map((p, i) => ({ ...p, menge: z.mengen[i] ?? 0 }))
        .filter(p => p.menge > 0),
      zahlung: {
        barCent:      parseInt(z.barInput || '0', 10) || 0,
        karteCent:    parseInt(z.karte    || '0', 10) || 0,
        sonstigeCent: 0,
      },
    }))
    onSubmit({ zahlungen })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rechnung teilen — Tisch ${tab.tischNummer}`}
      size="lg"
    >
      <div className="space-y-4">
        {/* Positions-Tabelle */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-1.5 pr-3 text-left font-medium text-gray-600">Artikel</th>
                {zahler.map((z, i) => (
                  <th key={z.id} className="px-2 py-1.5 text-center font-medium text-gray-600 min-w-[90px]">
                    Zahler {i + 1}
                  </th>
                ))}
                <th className="pl-2 py-1.5 text-right font-medium text-gray-400 text-xs">Ges.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tab.positionen.map((p, posIdx) => {
                const zugewiesen = zahler.reduce((s, z) => s + (z.mengen[posIdx] ?? 0), 0)
                const ok = zugewiesen === p.menge
                return (
                  <tr key={posIdx} className={ok ? '' : 'bg-red-50'}>
                    <td className="py-1.5 pr-3 text-gray-800 truncate max-w-[140px]">
                      {p.bezeichnung}
                    </td>
                    {zahler.map((z) => {
                      const m = z.mengen[posIdx] ?? 0
                      return (
                        <td key={z.id} className="px-2 py-1">
                          <div className="flex items-center justify-center gap-1">
                            <MengeButton onClick={() => updateMenge(z.id, posIdx, -1)}>−</MengeButton>
                            <span className="w-5 text-center font-medium">{m}</span>
                            <MengeButton onClick={() => updateMenge(z.id, posIdx, +1)}>+</MengeButton>
                          </div>
                        </td>
                      )
                    })}
                    <td className="pl-2 py-1.5 text-right text-xs text-gray-400">{p.menge}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Zahler hinzufügen */}
        {zahler.length < 6 && (
          <button
            type="button"
            onClick={addZahler}
            className="text-xs text-brand-600 hover:underline font-medium"
          >
            + Weiteren Zahler hinzufügen
          </button>
        )}

        {/* Zahlungsfelder pro Zahler */}
        <div className="space-y-3 pt-1 border-t border-gray-200">
          {zahler.map((z, i) => {
            const subtotal = tab.positionen.reduce(
              (s, p, posIdx) => s + p.preisBruttoCent * (z.mengen[posIdx] ?? 0), 0
            )
            const hatPositionen = subtotal > 0
            if (!hatPositionen) return null
            const bar   = parseInt(z.barInput || '0', 10) || 0
            const karte = parseInt(z.karte    || '0', 10) || 0
            const diff  = subtotal - bar - karte
            return (
              <div key={z.id} className="rounded-lg border border-gray-200 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-700">Zahler {i + 1}</span>
                  <span className="text-sm font-bold text-gray-900">{formatPreis(subtotal)}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs text-gray-500">Bar (Cent)</span>
                    <Input
                      inputMode="numeric"
                      placeholder="0"
                      value={z.barInput}
                      onChange={(e) => updateBar(z.id, e.target.value)}
                      className="mt-0.5 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-500">Karte (Cent)</span>
                    <Input
                      inputMode="numeric"
                      placeholder="0"
                      value={z.karte}
                      onChange={(e) => updateKarte(z.id, e.target.value)}
                      className="mt-0.5 text-sm"
                    />
                  </label>
                </div>
                <div className="flex gap-2 text-xs">
                  <button type="button" onClick={() => { updateBar(z.id, String(subtotal)); updateKarte(z.id, '') }} className="text-brand-600 hover:underline">Bar = {formatPreis(subtotal)}</button>
                  <span className="text-gray-300">·</span>
                  <button type="button" onClick={() => { updateKarte(z.id, String(subtotal)); updateBar(z.id, '') }} className="text-brand-600 hover:underline">Karte = {formatPreis(subtotal)}</button>
                </div>
                {diff !== 0 && (
                  <p className="text-xs text-red-600">
                    {diff > 0 ? `Noch ${formatPreis(diff)} offen` : `${formatPreis(-diff)} zu viel eingegeben`}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        {/* Validierungsfehler */}
        {positionsfehler.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 space-y-0.5">
            <p className="font-semibold">Positionen noch nicht vollständig verteilt:</p>
            {positionsfehler.map(f => <p key={f}>• {f}</p>)}
          </div>
        )}
        {fehler && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button
            onClick={handleSubmit}
            loading={loading}
            disabled={!kannSubmit}
            className="flex-1"
          >
            {zahlungenMitPositionen.length} Bons erstellen
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Artikel-Rabatte Modal
// ---------------------------------------------------------------------------

interface ArtikelRabatteModalProps {
  open:          boolean
  positionen:    TabPosition[]
  posRabatte:    Record<number, number>
  onBestaetigen: (neuePosRabatte: Record<number, number>) => void
  onClose:       () => void
}

function ArtikelRabatteModal({ open, positionen, posRabatte, onBestaetigen, onClose }: ArtikelRabatteModalProps) {
  const [lokaleRabatte, setLokaleRabatte] = useState<Record<number, number>>({})
  const [aktiverIdx, setAktiverIdx]       = useState<number | null>(null)
  const [prozentInput, setProzentInput]   = useState('')
  const [betragInput, setBetragInput]     = useState('')
  const [rabattTyp, setRabattTyp]         = useState<'prozent' | 'betrag'>('prozent')

  useEffect(() => {
    if (open) {
      setLokaleRabatte({ ...posRabatte })
      setAktiverIdx(null)
      setProzentInput('')
      setBetragInput('')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyRabatt = (idx: number) => {
    const basis = positionen[idx]!.preisBruttoCent
    let neuerPreis: number
    if (rabattTyp === 'prozent') {
      const p = parseInt(prozentInput || '0', 10) || 0
      if (p <= 0 || p > 100) return
      neuerPreis = Math.max(0, basis - Math.round(basis * p / 100))
    } else {
      const b = parseInt(betragInput || '0', 10) || 0
      if (b <= 0) return
      neuerPreis = Math.max(0, basis - b)
    }
    setLokaleRabatte(prev => ({ ...prev, [idx]: neuerPreis }))
    setAktiverIdx(null)
    setProzentInput('')
    setBetragInput('')
  }

  const removeRabatt = (idx: number) => {
    setLokaleRabatte(prev => {
      const next = { ...prev }
      delete next[idx]
      return next
    })
  }

  const gesamtNachRabatt = positionen.reduce(
    (s, p, i) => s + (lokaleRabatte[i] ?? p.preisBruttoCent) * p.menge, 0
  )
  const gesamtOriginal = positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)

  return (
    <Modal open={open} onClose={onClose} title="Artikel-Rabatte" size="lg">
      <div className="space-y-3">
        <ul className="divide-y divide-gray-100">
          {positionen.map((p, idx) => {
            const hatRabatt = idx in lokaleRabatte
            const aktuellerPreis = lokaleRabatte[idx] ?? p.preisBruttoCent
            const istAktiv = aktiverIdx === idx

            return (
              <li key={idx} className="py-2.5 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="flex-1 text-gray-800 truncate">
                    {p.menge}× {p.bezeichnung}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {hatRabatt ? (
                      <>
                        <span className="text-xs line-through text-gray-400">{formatPreis(p.preisBruttoCent)}</span>
                        <span className="text-sm font-medium text-green-700">{formatPreis(aktuellerPreis)}</span>
                        <button
                          type="button"
                          onClick={() => removeRabatt(idx)}
                          className="text-xs text-green-600 hover:text-red-500 px-1"
                        >×</button>
                      </>
                    ) : (
                      <span className="text-sm font-mono text-gray-700">{formatPreis(p.preisBruttoCent)}</span>
                    )}
                    {!istAktiv && (
                      <button
                        type="button"
                        onClick={() => { setAktiverIdx(idx); setProzentInput(''); setBetragInput(''); setRabattTyp('prozent') }}
                        className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-500 hover:border-brand-400 hover:text-brand-600 transition"
                      >
                        {hatRabatt ? 'ändern' : '% Rabatt'}
                      </button>
                    )}
                  </div>
                </div>

                {istAktiv && (
                  <div className="flex items-center gap-2 pl-2 flex-wrap">
                    <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
                      {(['prozent', 'betrag'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setRabattTyp(t)}
                          className={`px-2 py-1 font-medium transition ${rabattTyp === t ? 'bg-brand-600 text-white' : 'bg-white text-gray-600'}`}
                        >
                          {t === 'prozent' ? '%' : '€'}
                        </button>
                      ))}
                    </div>
                    {rabattTyp === 'prozent' ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          inputMode="numeric"
                          placeholder="10"
                          value={prozentInput}
                          onChange={e => setProzentInput(e.target.value.replace(/[^0-9]/g, ''))}
                          onKeyDown={e => e.key === 'Enter' && applyRabatt(idx)}
                          className="w-14 rounded border border-gray-300 px-1.5 py-1 text-xs text-center"
                        />
                        <span className="text-xs text-gray-400">%</span>
                        <div className="flex gap-0.5">
                          {[5, 10, 15, 20].map(p => (
                            <button key={p} type="button" onClick={() => setProzentInput(String(p))}
                              className={`rounded border px-1.5 py-0.5 text-xs transition ${prozentInput === String(p) ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-gray-200 bg-white text-gray-500'}`}
                            >{p}%</button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          inputMode="numeric"
                          placeholder="0"
                          value={betragInput}
                          onChange={e => setBetragInput(e.target.value.replace(/[^0-9]/g, ''))}
                          onKeyDown={e => e.key === 'Enter' && applyRabatt(idx)}
                          className="w-20 rounded border border-gray-300 px-1.5 py-1 text-xs text-center"
                        />
                        <span className="text-xs text-gray-400">Cent</span>
                      </div>
                    )}
                    <button type="button" onClick={() => applyRabatt(idx)}
                      className="rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
                    >✓</button>
                    <button type="button" onClick={() => setAktiverIdx(null)}
                      className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
                    >Abbruch</button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {Object.keys(lokaleRabatte).length > 0 && (
          <div className="rounded bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800 flex justify-between">
            <span>Ersparnis: <strong>−{formatPreis(gesamtOriginal - gesamtNachRabatt)}</strong></span>
            <span>Gesamt: <strong>{formatPreis(gesamtNachRabatt)}</strong></span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={() => onBestaetigen(lokaleRabatte)} className="flex-1">
            Übernehmen
          </Button>
        </div>
      </div>
    </Modal>
  )
}
