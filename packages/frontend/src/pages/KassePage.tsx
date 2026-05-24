import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artikel,
  BarzahlungsbelegInput,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  ModifikatorAuswahl,
  ModifikatorGruppe,
  TischTabErstellenInput,
  TischTabResponse,
} from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { artikelApi, belegApi, bonierApi, kategorieApi, modifikatorApi, posConfigApi, tischTabApi, zvtApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { hasBerechtigung } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { BonAnzeige } from '../components/BonAnzeige'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { ArtikelGrid } from '../components/ArtikelGrid'

// ---------------------------------------------------------------------------
// Warenkorb-Typen
// ---------------------------------------------------------------------------

interface KorbPosition {
  artikel:       Artikel
  menge:         number
  /** Ausgewählte Modifikatoren für diese Position */
  modifikatoren: ModifikatorAuswahl[]
  /** Gesamtpreis pro Einheit inkl. Modifikator-Aufschläge */
  preisCent:     number
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function KassePage() {
  const identity = getKasseIdentity()!
  const queryClient = useQueryClient()

  const [korb, setKorb] = useState<KorbPosition[]>([])
  const [tisch, setTisch] = useState<string>('1')
  const [kellner, setKellner] = useState<string>('Service')
  const [barInput, setBarInput] = useState<string>('')
  const [karteInput, setKarteInput] = useState<string>('')
  const [letzterBon, setLetzterBon] = useState<BelegResponse | null>(null)
  const [bonierungErgebnis, setBonierungErgebnis] = useState<BonierungErgebnis | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [zvtOffen, setZvtOffen] = useState(false)
  const [zvtBetrag, setZvtBetrag] = useState(0)

  // ZVT-Config holen — entscheidet ob bei Kartenzahlung Modal nötig ist
  const zvtCfg = useQuery({
    queryKey: ['zvt', identity.kasseId],
    queryFn:  () => zvtApi.getConfig(identity.kasseId),
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

  // Map: artikelId → ModifikatorGruppe[] (nur aktive Gruppen mit aktiven Optionen)
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

  const summeCent = useMemo(
    () => korb.reduce((sum, p) => sum + p.preisCent * p.menge, 0),
    [korb],
  )

  // ---------------------------------------------------------------------------
  // Warenkorb-Aktionen
  // ---------------------------------------------------------------------------

  const addArtikel = (a: Artikel, modifikatoren: ModifikatorAuswahl[]) => {
    setFehler(null)
    const aufschlag  = modifikatoren.reduce((s, m) => s + m.aufschlagCent, 0)
    const preisCent  = a.preisBruttoCent + aufschlag
    setKorb((prev) => {
      // Artikel ohne Modifikatoren: Menge erhöhen falls bereits vorhanden
      if (modifikatoren.length === 0) {
        const existing = prev.find((p) => p.artikel.id === a.id && p.modifikatoren.length === 0)
        if (existing) {
          return prev.map((p) =>
            p.artikel.id === a.id && p.modifikatoren.length === 0
              ? { ...p, menge: p.menge + 1 }
              : p,
          )
        }
      }
      // Neue Zeile (mit Modifikatoren immer neue Zeile für Übersichtlichkeit)
      return [...prev, { artikel: a, menge: 1, modifikatoren, preisCent }]
    })
  }

  const updateMenge = (idx: number, delta: number) => {
    setKorb((prev) =>
      prev.flatMap((p, i) => {
        if (i !== idx) return [p]
        const neueMenge = p.menge + delta
        if (neueMenge <= 0) return []
        return [{ ...p, menge: neueMenge }]
      }),
    )
  }

  const removeArtikel = (idx: number) => {
    setKorb((prev) => prev.filter((_, i) => i !== idx))
  }

  const reset = () => {
    setKorb([])
    setBarInput('')
    setKarteInput('')
    setFehler(null)
  }

  // ---------------------------------------------------------------------------
  // Beleg erstellen
  // ---------------------------------------------------------------------------

  const belegMutation = useMutation({
    mutationFn: belegApi.barzahlung,
    onSuccess: (beleg) => {
      setLetzterBon(beleg)
      reset()
      // Belege-Liste invalidieren, damit /belege beim nächsten Besuch frisch lädt
      queryClient.invalidateQueries({ queryKey: ['belege'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const nullbelegMutation = useMutation({
    mutationFn: () => belegApi.nullbeleg({ kasseId: identity.kasseId }),
    onSuccess: (beleg) => {
      setLetzterBon(beleg)
      queryClient.invalidateQueries({ queryKey: ['belege'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const bonierMutation = useMutation({
    mutationFn: (input: BonierungInput) => bonierApi.bonieren(input),
    onSuccess: (ergebnis) => {
      setBonierungErgebnis(ergebnis)
      // Artikel neu laden, damit Restbestände im POS sofort aktuell sind
      queryClient.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const handleBonieren = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Der Warenkorb ist leer.'); return }
    if (!tisch.trim())     { setFehler('Tisch fehlt.'); return }
    if (!kellner.trim())   { setFehler('Kellner fehlt.'); return }

    // Alle Positionen senden — der Server entscheidet über KDS- und Bonierdrucker-Routing
    bonierMutation.mutate({
      kasseId:    identity.kasseId,
      tisch:      tisch.trim(),
      kellner:    kellner.trim(),
      positionen: korb.map((p) => ({ artikelId: p.artikel.id, menge: p.menge })),
    })
  }

  const erstelleBeleg = (barCent: number, karteCent: number) => {
    const input: BarzahlungsbelegInput = {
      kasseId: identity.kasseId,
      positionen: korb.map((p) => {
        const base: BarzahlungsbelegInput['positionen'][0] = { artikelId: p.artikel.id, menge: p.menge }
        if (p.modifikatoren.length > 0) {
          base.einzelpreisBreuttoCent = p.preisCent
          base.bezeichnungZusatz = p.modifikatoren.map(m => m.name).join(', ')
        }
        return base
      }),
      zahlung: { barCent, karteCent, sonstigeCent: 0 },
    }
    belegMutation.mutate(input)
  }

  const handleBonErstellen = () => {
    setFehler(null)
    if (korb.length === 0) {
      setFehler('Der Warenkorb ist leer.')
      return
    }
    const bar   = parseInt(barInput   || '0', 10) || 0
    const karte = parseInt(karteInput || '0', 10) || 0

    if (bar + karte !== summeCent) {
      setFehler(`Zahlungssumme passt nicht: ${formatPreis(bar + karte)} statt ${formatPreis(summeCent)}`)
      return
    }

    // Kartenzahlung mit aktiviertem ZVT? Erst Terminal-Authorization, dann Beleg
    if (karte > 0 && zvtCfg.data?.zvtAktiv) {
      setZvtBetrag(karte)
      setZvtOffen(true)
      return
    }

    erstelleBeleg(bar, karte)
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-7xl px-4 py-4">
      {/* Kontext-Leiste: Tisch + Kellner */}
      <div className="mb-3 bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-700">Tisch</span>
          <Input
            value={tisch}
            onChange={(e) => setTisch(e.target.value)}
            className="w-20 text-center"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-700">Kellner</span>
          <Input
            value={kellner}
            onChange={(e) => setKellner(e.target.value)}
            className="w-40"
          />
        </label>
      </div>

      {hasBerechtigung('tische') && <OffeneTischeLeiste />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* ----- Linke Seite: Artikel-Buttons ----- */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200
                            flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <div className="px-4 pt-4 pb-2 shrink-0">
            <h2 className="text-sm font-semibold text-gray-700">Artikel</h2>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
            <ArtikelGrid
              artikel={artikelQuery.data ?? []}
              kategorien={kategorienQuery.data ?? []}
              artikelGruppen={artikelGruppenMap}
              onArtikelClick={addArtikel}
              loading={artikelQuery.isLoading}
              sichtbareKategorieIds={posConfigQuery.data?.sichtbareKategorieIds}
            />
          </div>
        </section>

        {/* ----- Rechte Seite: Warenkorb + Zahlung ----- */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-fit lg:sticky lg:top-20 max-h-[calc(100vh-6rem)]">
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">Warenkorb</h2>
          </div>

          {/* Warenkorb-Positionen */}
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-[10rem] max-h-[40vh]">
            {korb.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">Leer</p>
            ) : (
              <ul className="space-y-2">
                {korb.map((p, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{p.artikel.bezeichnung}</p>
                      {p.modifikatoren.length > 0 && (
                        <p className="text-xs text-brand-600 truncate">
                          {p.modifikatoren.map(m => m.name).join(', ')}
                        </p>
                      )}
                      <p className="text-xs text-gray-500">{formatPreis(p.preisCent)} × {p.menge}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <MengeButton onClick={() => updateMenge(idx, -1)}>−</MengeButton>
                      <span className="w-6 text-center font-medium">{p.menge}</span>
                      <MengeButton onClick={() => updateMenge(idx, +1)}>+</MengeButton>
                    </div>
                    <span className="w-20 text-right font-mono">
                      {formatPreis(p.preisCent * p.menge)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeArtikel(idx)}
                      className="text-gray-300 hover:text-red-500 px-1"
                      aria-label="Entfernen"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Summen + Zahlung */}
          <div className="px-4 py-3 border-t border-gray-200 space-y-3 bg-gray-50">
            <div className="flex items-center justify-between text-base font-bold text-gray-900">
              <span>Summe</span>
              <span>{formatPreis(summeCent)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <BetragField label="Bar (Cent)" value={barInput}   onChange={setBarInput}   />
              <BetragField label="Karte (Cent)" value={karteInput} onChange={setKarteInput} />
            </div>
            <p className="text-xs text-gray-500">
              Eingabe in Cent. Schnellbuttons:&nbsp;
              <button type="button" onClick={() => setBarInput(String(summeCent))} className="text-brand-600 hover:underline">Bar = Summe</button>
              {' · '}
              <button type="button" onClick={() => setKarteInput(String(summeCent))} className="text-brand-600 hover:underline">Karte = Summe</button>
            </p>

            {fehler && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="secondary" onClick={reset} className="flex-1">Leeren</Button>
              <Button
                variant="secondary"
                onClick={handleBonieren}
                loading={bonierMutation.isPending}
                className="flex-1"
                disabled={korb.length === 0}
              >
                Bonieren
              </Button>
              <Button
                onClick={handleBonErstellen}
                loading={belegMutation.isPending}
                className="flex-1"
                disabled={korb.length === 0}
              >
                Bon erstellen
              </Button>
            </div>

            <div className="pt-2 border-t border-gray-200 text-center">
              <button
                type="button"
                onClick={() => nullbelegMutation.mutate()}
                disabled={nullbelegMutation.isPending}
                className="text-xs text-gray-500 hover:text-brand-600 disabled:opacity-50"
              >
                {nullbelegMutation.isPending ? 'Wird erstellt…' : 'Nullbeleg erstellen (Tagesschluss ohne Umsatz)'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Erfolgs-Modal */}
      <Modal
        open={!!letzterBon}
        onClose={() => setLetzterBon(null)}
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
                        {STATION_LABELS[s.station]} <span className="font-mono text-xs opacity-60">({s.ip || '—'})</span>
                      </span>
                      <span>
                        {s.erfolgreich
                          ? `${s.positionen} Pos.`
                          : s.fehler ?? 'Fehler'}
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
                        {d.erfolgreich
                          ? `${d.positionen} Pos.`
                          : d.fehler ?? 'Fehler'}
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

      {/* Kartenzahlung (ZVT) — vor Beleg-Erstellung */}
      <KartenzahlungModal
        open={zvtOffen}
        kasseId={identity.kasseId}
        betragCent={zvtBetrag}
        onErfolg={() => {
          setZvtOffen(false)
          const bar   = parseInt(barInput   || '0', 10) || 0
          const karte = parseInt(karteInput || '0', 10) || 0
          erstelleBeleg(bar, karte)
        }}
        onAbbruch={() => {
          setZvtOffen(false)
          setFehler('Kartenzahlung abgebrochen — kein Beleg erstellt')
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Offene-Tische-Leiste
// ---------------------------------------------------------------------------

function OffeneTischeLeiste() {
  const identity  = getKasseIdentity()!
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [modalOffen, setModalOffen] = useState(false)
  const [fehler,     setFehler]     = useState<string | null>(null)

  const tabsQuery = useQuery({
    queryKey:        ['tisch-tabs', identity.kasseId],
    queryFn:         () => tischTabApi.list(identity.kasseId),
    refetchInterval: 30_000,
  })

  const erstelleMutation = useMutation({
    mutationFn: (input: TischTabErstellenInput) => tischTabApi.erstelle(input),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setModalOffen(false)
      navigate(`/tische/${tab.id}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const tabs = tabsQuery.data ?? []

  return (
    <>
      <div className="mb-3 bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2 flex items-center gap-2 min-h-[48px]">
        <span className="text-xs font-semibold text-gray-500 shrink-0 uppercase tracking-wide">
          Tische
        </span>

        {tabsQuery.isLoading && (
          <span className="text-xs text-gray-400">Wird geladen…</span>
        )}

        {!tabsQuery.isLoading && tabs.length === 0 && (
          <span className="text-xs text-gray-400">Keine offenen Tische</span>
        )}

        {tabs.length > 0 && (
          <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
            <div className="flex gap-1.5 pr-1">
              {tabs.map((tab) => (
                <TischChip
                  key={tab.id}
                  tab={tab}
                  onClick={() => navigate(`/tische/${tab.id}`)}
                />
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => { setFehler(null); setModalOffen(true) }}
          className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline px-1"
        >
          + Neuer Tisch
        </button>
      </div>

      <Modal
        open={modalOffen}
        onClose={() => setModalOffen(false)}
        title="Neuen Tisch öffnen"
      >
        <NeuerTischFormular
          kasseId={identity.kasseId}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={(input) => { setFehler(null); erstelleMutation.mutate(input) }}
          onAbbrechen={() => setModalOffen(false)}
        />
      </Modal>
    </>
  )
}

function TischChip({ tab, onClick }: { tab: TischTabResponse; onClick: () => void }) {
  const minOffen  = Math.floor((Date.now() - new Date(tab.geoffnetAm).getTime()) / 60_000)
  const dauerText = minOffen < 60
    ? `${minOffen}'`
    : `${Math.floor(minOffen / 60)}h${minOffen % 60 > 0 ? `${minOffen % 60}'` : ''}`

  // Farbe je nach Wartezeit
  const farbe = minOffen < 30
    ? 'border-orange-300 bg-orange-50 hover:border-orange-500 hover:bg-orange-100 text-orange-800'
    : minOffen < 60
    ? 'border-amber-400 bg-amber-50 hover:border-amber-600 hover:bg-amber-100 text-amber-900'
    : 'border-red-300 bg-red-50 hover:border-red-500 hover:bg-red-100 text-red-800'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition ${farbe}`}
    >
      <span className="text-base font-bold leading-none">{tab.tischNummer}</span>
      <span className="flex flex-col items-start leading-tight">
        <span className="text-xs font-semibold">{formatPreis(tab.summeGesamtCent)}</span>
        <span className="text-[11px] opacity-70">{tab.kellner} · {dauerText}</span>
      </span>
    </button>
  )
}

interface NeuerTischFormularProps {
  kasseId:     string
  loading:     boolean
  fehler:      string | null
  onSubmit:    (input: TischTabErstellenInput) => void
  onAbbrechen: () => void
}

function NeuerTischFormular({ kasseId, loading, fehler, onSubmit, onAbbrechen }: NeuerTischFormularProps) {
  const [tischNummer, setTischNummer] = useState('')
  const [kellner,     setKellner]     = useState('Service')

  const submit = () => {
    if (!tischNummer.trim()) return
    onSubmit({ kasseId, tischNummer: tischNummer.trim(), kellner: kellner.trim() || 'Service' })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Tischnummer / -bezeichnung</span>
        <Input
          autoFocus
          value={tischNummer}
          onChange={(e) => setTischNummer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. 1, Terrasse 3, Bar …"
          className="mt-1"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Kellner</span>
        <Input
          value={kellner}
          onChange={(e) => setKellner(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1"
        />
      </label>
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!tischNummer.trim()}>
          Tisch öffnen
        </Button>
      </div>
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
      className="h-6 w-6 rounded border border-gray-300 bg-white text-sm font-bold text-gray-700 hover:bg-gray-100"
    >
      {children}
    </button>
  )
}

interface BetragFieldProps {
  label:    string
  value:    string
  onChange: (v: string) => void
}

function BetragField({ label, value, onChange }: BetragFieldProps) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <Input
        inputMode="numeric"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        className="mt-0.5"
      />
    </label>
  )
}
