import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artikel,
  BarzahlungsbelegInput,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
} from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { artikelApi, belegApi, bonierApi, kategorieApi, zvtApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
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
  artikel: Artikel
  menge:   number
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

  const summeCent = useMemo(
    () => korb.reduce((sum, p) => sum + p.artikel.preisBruttoCent * p.menge, 0),
    [korb],
  )

  // ---------------------------------------------------------------------------
  // Warenkorb-Aktionen
  // ---------------------------------------------------------------------------

  const addArtikel = (a: Artikel) => {
    setFehler(null)
    setKorb((prev) => {
      const existing = prev.find((p) => p.artikel.id === a.id)
      if (existing) {
        return prev.map((p) => p.artikel.id === a.id ? { ...p, menge: p.menge + 1 } : p)
      }
      return [...prev, { artikel: a, menge: 1 }]
    })
  }

  const updateMenge = (artikelId: string, delta: number) => {
    setKorb((prev) =>
      prev.flatMap((p) => {
        if (p.artikel.id !== artikelId) return [p]
        const neueMenge = p.menge + delta
        if (neueMenge <= 0) return []
        return [{ ...p, menge: neueMenge }]
      }),
    )
  }

  const removeArtikel = (artikelId: string) => {
    setKorb((prev) => prev.filter((p) => p.artikel.id !== artikelId))
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
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const handleBonieren = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Der Warenkorb ist leer.'); return }
    if (!tisch.trim())     { setFehler('Tisch fehlt.'); return }
    if (!kellner.trim())   { setFehler('Kellner fehlt.'); return }

    // Nur Artikel mit Station bonieren — Server-seitig wird das nochmal geprüft
    const positionen = korb
      .filter((p) => p.artikel.station)
      .map((p) => ({ artikelId: p.artikel.id, menge: p.menge }))
    if (positionen.length === 0) {
      setFehler('Kein Artikel im Warenkorb hat eine KDS-Station hinterlegt.')
      return
    }

    bonierMutation.mutate({
      kasseId: identity.kasseId,
      tisch:   tisch.trim(),
      kellner: kellner.trim(),
      positionen,
    })
  }

  const erstelleBeleg = (barCent: number, karteCent: number) => {
    const input: BarzahlungsbelegInput = {
      kasseId:    identity.kasseId,
      positionen: korb.map((p) => ({ artikelId: p.artikel.id, menge: p.menge })),
      zahlung:    { barCent, karteCent, sonstigeCent: 0 },
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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* ----- Linke Seite: Artikel-Buttons ----- */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Artikel</h2>
          <ArtikelGrid
            artikel={artikelQuery.data ?? []}
            kategorien={kategorienQuery.data ?? []}
            onArtikelClick={addArtikel}
            loading={artikelQuery.isLoading}
          />
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
                {korb.map((p) => (
                  <li key={p.artikel.id} className="flex items-center gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{p.artikel.bezeichnung}</p>
                      <p className="text-xs text-gray-500">{formatPreis(p.artikel.preisBruttoCent)} × {p.menge}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <MengeButton onClick={() => updateMenge(p.artikel.id, -1)}>−</MengeButton>
                      <span className="w-6 text-center font-medium">{p.menge}</span>
                      <MengeButton onClick={() => updateMenge(p.artikel.id, +1)}>+</MengeButton>
                    </div>
                    <span className="w-20 text-right font-mono">
                      {formatPreis(p.artikel.preisBruttoCent * p.menge)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeArtikel(p.artikel.id)}
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
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Bonierbons an folgende Stationen gesendet:
            </p>
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
                    {STATION_LABELS[s.station]} <span className="font-mono text-xs text-gray-500">({s.ip || '—'})</span>
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
