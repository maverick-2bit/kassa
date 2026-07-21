/**
 * WareneingangPage — Schnelle Lagerstand-Pflege.
 *
 * Zwei Modi:
 *   Wareneingang → Zahl addieren (Lieferung ankam)
 *   Inventur     → Bestand absolut setzen (körperliche Zählung)
 *
 * Dargestellt werden:
 *   - Alle Artikel mit lagerstandAktiv = true
 *   - Alle Modifikator-Varianten mit lagerstandMenge !== null
 *     (unabhängig vom Artikel-Lagerstand)
 *
 * Die Eingaben werden als Bulk-Request gespeichert (eine Transaktion).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LagerstandBulkInput } from '@kassa/shared'
import { artikelApi, kategorieApi, lagerstandApi, modifikatorApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { SeriennummernModal } from '../components/SeriennummernModal'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface ArtikelZeile {
  key:          string
  type:         'artikel'
  id:           string
  bezeichnung:  string
  kategorieName: string | null
  menge:        number | null
  seriennummernAktiv: boolean
  istBestandteil: boolean
}

type TypFilter = 'alle' | 'verkauf' | 'rohstoff'

interface VarianteZeile {
  key:          string
  type:         'variante'
  id:           string
  bezeichnung:  string   // "GruppenName › VariantenName"
  menge:        number   // niemals null (nur Varianten mit gesetztem Lagerstand)
}

type Zeile = ArtikelZeile | VarianteZeile

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function WareneingangPage() {
  const identity = getKasseIdentity()!
  const qc       = useQueryClient()

  const [modus,       setModus]       = useState<'wareneingang' | 'inventur'>('wareneingang')
  const [typFilter,   setTypFilter]   = useState<TypFilter>('alle')
  const [suche,       setSuche]       = useState('')
  const [eingaben,    setEingaben]    = useState<Record<string, string>>({})
  const [gespeichert, setGespeichert] = useState(false)
  const [serialModal, setSerialModal] = useState<{ id: string; name: string } | null>(null)
  const prevModusRef                  = useRef(modus)

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  const artikelQuery    = useQuery({
    queryKey: ['artikel', identity.mandantId, false],
    queryFn:  () => artikelApi.list(identity.mandantId, false),
  })
  const kategorienQuery = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(false),
  })
  const gruppenQuery    = useQuery({
    queryKey: ['modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeGruppen(),
  })

  // ---------------------------------------------------------------------------
  // Zeilen berechnen
  // ---------------------------------------------------------------------------

  const { artZeilen, varZeilen } = useMemo(() => {
    const kategorienMap = new Map(
      (kategorienQuery.data ?? []).map(k => [k.id, k.name]),
    )

    // Artikel mit aktivem Lagerstand
    const artRows: ArtikelZeile[] = (artikelQuery.data ?? [])
      .filter(a => a.lagerstandAktiv || a.seriennummernAktiv)
      .sort((a, b) => {
        const ka = a.kategorieId ? (kategorienMap.get(a.kategorieId) ?? '') : ''
        const kb = b.kategorieId ? (kategorienMap.get(b.kategorieId) ?? '') : ''
        return ka.localeCompare(kb) || a.bezeichnung.localeCompare(b.bezeichnung)
      })
      .map(a => ({
        key:           `a:${a.id}`,
        type:          'artikel' as const,
        id:            a.id,
        bezeichnung:   a.bezeichnung,
        kategorieName: a.kategorieId ? (kategorienMap.get(a.kategorieId) ?? null) : null,
        menge:         a.lagerstandMenge,
        seriennummernAktiv: a.seriennummernAktiv,
        istBestandteil: a.istBestandteil,
      }))

    // Modifikator-Varianten mit gesetztem Lagerstand
    const varRows: VarianteZeile[] = []
    for (const gruppe of (gruppenQuery.data ?? [])) {
      for (const mod of gruppe.modifikatoren) {
        if (mod.lagerstandMenge === null) continue
        varRows.push({
          key:         `m:${mod.id}`,
          type:        'variante' as const,
          id:          mod.id,
          bezeichnung: `${gruppe.name} › ${mod.name}`,
          menge:       mod.lagerstandMenge,
        })
      }
    }
    varRows.sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))

    return { artZeilen: artRows, varZeilen: varRows }
  }, [artikelQuery.data, kategorienQuery.data, gruppenQuery.data])

  // ---------------------------------------------------------------------------
  // Modus-Wechsel → Eingaben zurücksetzen / vorabfüllen
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (prevModusRef.current === modus) return
    prevModusRef.current = modus

    if (modus === 'inventur') {
      // Inventur: Eingaben mit aktuellem Bestand vorbefüllen
      const prefill: Record<string, string> = {}
      for (const z of [...artZeilen, ...varZeilen]) {
        if (z.menge !== null) prefill[z.key] = String(z.menge)
      }
      setEingaben(prefill)
    } else {
      setEingaben({})
    }
  }, [modus, artZeilen, varZeilen])

  // ---------------------------------------------------------------------------
  // Suche filtern
  // ---------------------------------------------------------------------------
  const sucheBereinigt = suche.trim().toLowerCase()
  const filtere = (zeilen: Zeile[]) =>
    sucheBereinigt
      ? zeilen.filter(z => z.bezeichnung.toLowerCase().includes(sucheBereinigt))
      : zeilen

  // Typ-Filter: nur Rohstoffe / nur Verkaufsartikel (Varianten sind weder noch → bei
  // aktivem Typ-Filter ausgeblendet).
  const artNachTyp =
    typFilter === 'rohstoff' ? artZeilen.filter(z => z.istBestandteil)
    : typFilter === 'verkauf' ? artZeilen.filter(z => !z.istBestandteil)
    : artZeilen

  const artGefiltert = filtere(artNachTyp) as ArtikelZeile[]
  const varGefiltert = (typFilter === 'alle' ? filtere(varZeilen) : []) as VarianteZeile[]

  const anzahlRohstoffe = artZeilen.filter(z => z.istBestandteil).length

  // ---------------------------------------------------------------------------
  // Eingaben zählen
  // ---------------------------------------------------------------------------
  const anzahlGeaendert = Object.values(eingaben).filter(v => v.trim() !== '').length

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------
  const save = useMutation({
    mutationFn: (input: LagerstandBulkInput) => lagerstandApi.bulk(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      setEingaben({})
      setGespeichert(true)
      setTimeout(() => setGespeichert(false), 3000)
    },
  })

  const handleSpeichern = () => {
    const artEintraege  = artZeilen
      .filter(z => eingaben[z.key]?.trim())
      .map(z => ({ id: z.id, menge: parseInt(eingaben[z.key]!, 10) }))
      .filter(e => !isNaN(e.menge) && e.menge >= 0)

    const varEintraege  = varZeilen
      .filter(z => eingaben[z.key]?.trim())
      .map(z => ({ id: z.id, menge: parseInt(eingaben[z.key]!, 10) }))
      .filter(e => !isNaN(e.menge) && e.menge >= 0)

    if (artEintraege.length + varEintraege.length === 0) return

    save.mutate({
      modus:         modus === 'inventur' ? 'absolut' : 'wareneingang',
      artikel:       artEintraege,
      modifikatoren: varEintraege,
    })
  }

  const handleZuruecksetzen = () => {
    if (modus === 'inventur') {
      const prefill: Record<string, string> = {}
      for (const z of [...artZeilen, ...varZeilen]) {
        if (z.menge !== null) prefill[z.key] = String(z.menge)
      }
      setEingaben(prefill)
    } else {
      setEingaben({})
    }
  }

  const setEingabe = (key: string, val: string) =>
    setEingaben(prev => ({ ...prev, [key]: val }))

  // ---------------------------------------------------------------------------
  // Laden / Leerzustand
  // ---------------------------------------------------------------------------
  const isLoading = artikelQuery.isLoading || gruppenQuery.isLoading

  const keineEintraege = !isLoading && artZeilen.length === 0 && varZeilen.length === 0
  // Es gibt Einträge, aber der aktive Filter/die Suche trifft nichts.
  const keinTreffer = !isLoading && !keineEintraege
    && artGefiltert.length === 0 && varGefiltert.length === 0

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-ink">Wareneingang / Inventur</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Lagerbestände schnell und übersichtlich pflegen — einzeln oder als Gesamtzählung.
        </p>
      </div>

      {/* Modus-Toggle */}
      <div className="inline-flex rounded-lg border border-line overflow-hidden shadow-sm">
        {(['wareneingang', 'inventur'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setModus(m)}
            className={`px-5 py-2.5 text-sm font-medium transition ${
              modus === m
                ? 'bg-brand-600 text-white'
                : 'bg-panel text-ink-muted hover:bg-panel-2'
            }`}
          >
            {m === 'wareneingang' ? '+ Wareneingang' : '✓ Inventur'}
          </button>
        ))}
      </div>

      {/* Modus-Erklärung */}
      <div className="rounded-lg bg-panel-2 border border-line px-4 py-3 text-sm text-ink-muted">
        {modus === 'wareneingang' ? (
          <p>
            <strong>Wareneingang:</strong> Die eingegebene Menge wird zum bestehenden Bestand
            addiert. Leer lassen = kein Zugang für diesen Artikel.
          </p>
        ) : (
          <p>
            <strong>Inventur:</strong> Der bestehende Bestand wird auf den eingegebenen Wert
            gesetzt. Eingaben sind mit dem aktuellen Stand vorbefüllt — einfach korrigieren.
          </p>
        )}
      </div>

      {/* Suche */}
      <input
        type="search"
        placeholder="Artikel oder Variante suchen …"
        value={suche}
        onChange={(e) => setSuche(e.target.value)}
        className="w-full rounded-lg border border-line-strong px-3 py-2.5 text-sm
                   placeholder-ink-subtle shadow-sm focus:border-brand-500 focus:ring-1
                   focus:ring-brand-500 outline-none"
      />

      {/* Typ-Filter — nur relevant wenn es Rohstoffe gibt */}
      {!isLoading && anzahlRohstoffe > 0 && (
        <div className="inline-flex rounded-lg border border-line overflow-hidden shadow-sm">
          {([
            ['alle',     'Alle'],
            ['verkauf',  'Verkaufsartikel'],
            ['rohstoff', `Rohstoffe (${anzahlRohstoffe})`],
          ] as const).map(([wert, label]) => (
            <button
              key={wert}
              type="button"
              onClick={() => setTypFilter(wert)}
              className={`px-4 py-2 text-sm font-medium transition ${
                typFilter === wert
                  ? 'bg-brand-600 text-white'
                  : 'bg-panel text-ink-muted hover:bg-panel-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Laden */}
      {isLoading && (
        <p className="text-sm text-ink-muted py-4 text-center">Wird geladen…</p>
      )}

      {/* Keine Einträge */}
      {keineEintraege && (
        <div className="rounded-lg border border-dashed border-line-strong p-8 text-center">
          <p className="text-sm text-ink-muted">
            Noch keine Artikel mit aktiviertem Lagerstand vorhanden.
          </p>
          <p className="mt-1 text-xs text-ink-subtle">
            Lagerstand in der <a href="/artikel" className="text-brand-600 hover:underline">Artikel-Verwaltung</a> aktivieren.
          </p>
        </div>
      )}

      {/* Filter/Suche trifft nichts */}
      {keinTreffer && (
        <div className="rounded-lg border border-dashed border-line-strong p-8 text-center">
          <p className="text-sm text-ink-muted">
            {typFilter === 'rohstoff'
              ? 'Keine Rohstoffe mit Lagerstand gefunden.'
              : typFilter === 'verkauf'
                ? 'Keine Verkaufsartikel mit Lagerstand gefunden.'
                : 'Keine Treffer für die Suche.'}
          </p>
        </div>
      )}

      {/* ---- Artikel mit Lagerstand ---- */}
      {artGefiltert.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide">
            Artikel-Lagerstand
          </h2>
          <Tabelle
            zeilen={artGefiltert}
            modus={modus}
            eingaben={eingaben}
            onEingabe={setEingabe}
            onSerial={(id, name) => setSerialModal({ id, name })}
          />
        </section>
      )}

      {/* ---- Varianten-Lagerstand ---- */}
      {varGefiltert.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide">
            Varianten-Lagerstand
          </h2>
          <Tabelle
            zeilen={varGefiltert}
            modus={modus}
            eingaben={eingaben}
            onEingabe={setEingabe}
            onSerial={(id, name) => setSerialModal({ id, name })}
          />
        </section>
      )}

      {/* Footer */}
      {!keineEintraege && !isLoading && (
        <div className="flex items-center justify-between pt-2 border-t border-line">
          <Button variant="secondary" onClick={handleZuruecksetzen}>
            Zurücksetzen
          </Button>

          <div className="flex items-center gap-3">
            {gespeichert && (
              <span className="text-sm text-green-600 font-medium">✓ Gespeichert</span>
            )}
            {save.isError && (
              <span className="text-sm text-red-600">Fehler beim Speichern</span>
            )}
            <Button
              onClick={handleSpeichern}
              loading={save.isPending}
              disabled={anzahlGeaendert === 0}
            >
              {modus === 'wareneingang'
                ? `Zugang buchen${anzahlGeaendert > 0 ? ` (${anzahlGeaendert})` : ''}`
                : `Inventur speichern${anzahlGeaendert > 0 ? ` (${anzahlGeaendert})` : ''}`
              }
            </Button>
          </div>
        </div>
      )}

      {serialModal && (
        <SeriennummernModal
          artikelId={serialModal.id}
          artikelName={serialModal.name}
          open={true}
          onClose={() => setSerialModal(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabellen-Hilfsbaustein
// ---------------------------------------------------------------------------

function Tabelle({
  zeilen,
  modus,
  eingaben,
  onEingabe,
  onSerial,
}: {
  zeilen:    Zeile[]
  modus:     'wareneingang' | 'inventur'
  eingaben:  Record<string, string>
  onEingabe: (key: string, val: string) => void
  onSerial:  (id: string, name: string) => void
}) {
  const spalteLabel = modus === 'wareneingang' ? '+ Zugang' : 'Neuer Bestand'

  // Kategorien in Gruppen zusammenfassen (nur bei Artikel-Zeilen)
  const gruppiertNachKat = useMemo(() => {
    const gruppen: { kategorie: string | null; zeilen: Zeile[] }[] = []
    for (const z of zeilen) {
      const kat = z.type === 'artikel' ? z.kategorieName : null
      const letzte = gruppen[gruppen.length - 1]
      if (letzte && letzte.kategorie === kat) {
        letzte.zeilen.push(z)
      } else {
        gruppen.push({ kategorie: kat, zeilen: [z] })
      }
    }
    return gruppen
  }, [zeilen])

  return (
    <div className="rounded-lg border border-line bg-panel overflow-hidden shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-ink-muted border-b border-line">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Bezeichnung</th>
            <th className="px-4 py-2.5 font-semibold text-right w-24">Aktuell</th>
            <th className="px-4 py-2.5 font-semibold text-right w-36">{spalteLabel}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {gruppiertNachKat.map((gruppe) => (
            <>
              {/* Kategorie-Trennzeile (nur bei Artikel-Zeilen mit Kategorie) */}
              {gruppe.kategorie && (
                <tr key={`kat:${gruppe.kategorie}`} className="bg-panel-2">
                  <td
                    colSpan={3}
                    className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle"
                  >
                    {gruppe.kategorie}
                  </td>
                </tr>
              )}

              {gruppe.zeilen.map((z) => {
                const wert    = eingaben[z.key] ?? ''
                const istNeu  = wert !== '' && wert !== String(z.menge ?? '')
                return (
                  <tr
                    key={z.key}
                    className={istNeu ? 'bg-brand-50' : 'hover:bg-panel-2'}
                  >
                    <td className="px-4 py-2.5 text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        {z.bezeichnung}
                        {z.type === 'artikel' && z.istBestandteil && (
                          <span className="shrink-0 rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide leading-none">
                            Rohstoff
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-ink-muted tabular-nums">
                      {z.menge !== null ? z.menge : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {z.type === 'artikel' && z.seriennummernAktiv ? (
                        <Button size="sm" variant="secondary" onClick={() => onSerial(z.id, z.bezeichnung)}>
                          Seriennummern
                        </Button>
                      ) : (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={wert}
                          placeholder={modus === 'wareneingang' ? '0' : String(z.menge ?? '')}
                          onChange={(e) => onEingabe(z.key, e.target.value)}
                          className={`
                            w-24 rounded-md border text-right px-2 py-1.5 text-sm tabular-nums
                            focus:outline-none focus:ring-2 focus:ring-brand-500
                            ${istNeu
                              ? 'border-brand-400 bg-panel font-semibold text-brand-800'
                              : 'border-line-strong bg-panel text-ink'
                            }
                          `}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}
