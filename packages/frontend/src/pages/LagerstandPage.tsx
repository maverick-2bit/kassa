import { useMemo, useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BESTELLVORSCHLAG_STANDARD_TAGE, type Artikel, type BestellvorschlagZeile } from '@kassa/shared'
import { baumFlach, kategoriePfad } from '../lib/kategorie-baum'
import { artikelApi, einkaufBestellungApi, kategorieApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { heuteKalendertag } from '../lib/geschaeftstag'
import { berichtPdfVorschauUrl, downloadBerichtPdf } from '../lib/pdf'
import { alsCsv, ladeCsvHerunter, reichweiteTabelle } from '../lib/bestellvorschlagExport'
import { PdfVorschauModal } from '../components/PdfVorschauModal'

const zahl = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 1 })

/** Erwartete Reichweite in Tagen: rot unter einer Woche, gelb unter dem Rückblick */
function reichweiteFarbe(tageReicht: number | null, rueckblick: number): string {
  if (tageReicht === null) return 'text-ink-subtle'
  if (tageReicht < 7) return 'text-red-600 font-semibold'
  if (tageReicht < rueckblick) return 'text-yellow-700 font-semibold'
  return 'text-ink'
}

// ---------------------------------------------------------------------------
// Status-Logik
// ---------------------------------------------------------------------------

type LagerStatus = 'kritisch' | 'niedrig' | 'ok' | 'unbekannt'

function lagerStatus(a: Artikel): LagerStatus {
  if (!a.lagerstandAktiv) return 'unbekannt'
  const menge = a.lagerstandMenge
  if (menge === null || menge === undefined) return 'kritisch'
  if (menge <= 0) return 'kritisch'
  if (a.mindestbestand !== null && a.mindestbestand !== undefined && menge <= a.mindestbestand) return 'niedrig'
  return 'ok'
}

const STATUS_FARBE: Record<LagerStatus, string> = {
  kritisch:  'bg-red-100 text-red-800 border-red-200',
  niedrig:   'bg-yellow-100 text-yellow-800 border-yellow-200',
  ok:        'bg-green-100 text-green-800 border-green-200',
  unbekannt: 'bg-panel-2 text-ink-muted border-line',
}

const STATUS_LABEL: Record<LagerStatus, string> = {
  kritisch:  'Kritisch',
  niedrig:   'Niedrig',
  ok:        'OK',
  unbekannt: '–',
}

const STATUS_DOT: Record<LagerStatus, string> = {
  kritisch:  'bg-red-500',
  niedrig:   'bg-yellow-500',
  ok:        'bg-green-500',
  unbekannt: 'bg-gray-400',
}

// ---------------------------------------------------------------------------
// Inline-Editor für Mindestbestand
// ---------------------------------------------------------------------------

function MindestbestandCell({
  artikel,
  onSave,
}: {
  artikel: Artikel
  onSave: (id: string, value: number | null) => void
}) {
  const [editing, setEditing]   = useState(false)
  const [wert, setWert]         = useState(
    artikel.mindestbestand !== null && artikel.mindestbestand !== undefined
      ? String(artikel.mindestbestand)
      : '',
  )
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 30)
  }

  const commit = () => {
    setEditing(false)
    const trimmed = wert.trim()
    if (trimmed === '') {
      onSave(artikel.id, null)
    } else {
      const num = parseInt(trimmed, 10)
      if (!isNaN(num) && num >= 0) onSave(artikel.id, num)
      else setWert(artikel.mindestbestand !== null && artikel.mindestbestand !== undefined ? String(artikel.mindestbestand) : '')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter')  commit()
    if (e.key === 'Escape') { setEditing(false); setWert(artikel.mindestbestand !== null && artikel.mindestbestand !== undefined ? String(artikel.mindestbestand) : '') }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        value={wert}
        onChange={e => setWert(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="w-24 px-2 py-0.5 border border-brand-400 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="min-w-[4rem] px-2 py-0.5 text-sm text-right rounded hover:bg-panel-2 border border-transparent hover:border-line-strong transition"
      title="Klicken zum Bearbeiten"
    >
      {artikel.mindestbestand !== null && artikel.mindestbestand !== undefined
        ? artikel.mindestbestand
        : <span className="text-ink-subtle italic">–</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function LagerstandPage() {
  const auth         = getAuth()
  const identity     = getKasseIdentity()
  const queryClient  = useQueryClient()
  const [filter, setFilter] = useState<'alle' | 'alarm'>('alle')
  const [suche, setSuche]   = useState('')
  const [sortierung, setSortierung] = useState<'status' | 'reichweite'>('status')
  const [tage, setTage] = useState(BESTELLVORSCHLAG_STANDARD_TAGE)
  const [exportFehler, setExportFehler] = useState<string | null>(null)
  const [vorschauUrl, setVorschauUrl] = useState<string | null>(null)

  // Verbrauch der letzten Tage → erwartete Reichweite (dieselbe Rechnung wie die Bestellliste)
  const verbrauchQ = useQuery({
    queryKey: ['bestellvorschlag', tage, tage],
    queryFn:  () => einkaufBestellungApi.vorschlag({ tage, reichweite: tage }),
  })
  const verbrauch = useMemo(
    () => new Map((verbrauchQ.data?.zeilen ?? []).map(z => [z.artikelId, z] as [string, BestellvorschlagZeile])),
    [verbrauchQ.data],
  )

  // Nur aktive: deaktivierte Artikel sollen keinen Lager-Alarm auslösen
  const { data: alleArtikel = [], isLoading } = useQuery({
    queryKey: ['artikel', auth?.mandant.id, true],
    queryFn:  () => artikelApi.list(auth!.mandant.id, true),
    enabled:  !!auth,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, mindestbestand }: { id: string; mindestbestand: number | null }) =>
      artikelApi.update(id, { mindestbestand }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['artikel'] })
    },
  })

  const lagerAktivierenMutation = useMutation({
    mutationFn: (kategorieId: string | null) => artikelApi.lagerAktivieren(kategorieId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['artikel'] })
    },
  })

  // Nur Lagerstand-Artikel
  const lagerArtikel = alleArtikel.filter(a => a.lagerstandAktiv)

  // Statistik
  const stats = {
    gesamt:   lagerArtikel.length,
    ok:       lagerArtikel.filter(a => lagerStatus(a) === 'ok').length,
    niedrig:  lagerArtikel.filter(a => lagerStatus(a) === 'niedrig').length,
    kritisch: lagerArtikel.filter(a => lagerStatus(a) === 'kritisch').length,
  }

  // Filter + Suche
  const angezeigt = lagerArtikel
    .filter(a => filter === 'alle' || lagerStatus(a) === 'kritisch' || lagerStatus(a) === 'niedrig')
    .filter(a => !suche || a.bezeichnung.toLowerCase().includes(suche.toLowerCase()))
    .sort((a, b) => {
      if (sortierung === 'reichweite') {
        // Kürzeste Reichweite zuerst; ohne Verbrauch (reicht „ewig") ans Ende
        const ra = verbrauch.get(a.id)?.reichtTageBestand ?? Infinity
        const rb = verbrauch.get(b.id)?.reichtTageBestand ?? Infinity
        if (ra !== rb) return ra - rb
        return a.bezeichnung.localeCompare(b.bezeichnung)
      }
      // Kritisch zuerst, dann Niedrig, dann OK
      const prio: Record<LagerStatus, number> = { kritisch: 0, niedrig: 1, ok: 2, unbekannt: 3 }
      const diff = prio[lagerStatus(a)] - prio[lagerStatus(b)]
      if (diff !== 0) return diff
      return a.bezeichnung.localeCompare(b.bezeichnung)
    })

  // Nur aktive: Auswahl für „Warengruppe in Lagerführung aufnehmen"
  const kategorienQuery = useQuery({
    queryKey: ['kategorien', identity?.kasseId],
    queryFn:  () => kategorieApi.list(true),
    enabled:  !!identity,
  })

  const [gewaehlteKategorie, setGewaehlteKategorie] = useState<string>('alle')

  // ── Export / PDF / Druck der Liste mit Reichweite ──────────────────────────
  const tabelle = () => reichweiteTabelle(angezeigt.map(a => {
    const v = verbrauch.get(a.id)
    return {
      bezeichnung: a.bezeichnung, artikelnummer: a.artikelnummer ?? null, bestand: a.lagerstandMenge ?? 0,
      mindestbestand: a.mindestbestand ?? null, verbrauch: v?.verbrauch ?? 0, verbrauchProTag: v?.verbrauchProTag ?? 0,
      reichtTageBestand: v?.reichtTageBestand ?? null, unterwegs: v?.unterwegs ?? 0, reichtTage: v?.reichtTage ?? null,
    }
  }), tage)
  const titel = 'Lagerstand und Reichweite'
  const zeitraum = `Erwartete Reichweite aus dem Ø-Verbrauch der letzten ${tage} Tage`
  const firma = auth?.mandant.firmenname ?? ''
  const dateiBasis = `Lagerstand-Reichweite-${heuteKalendertag()}`
  const pdf = async () => {
    try { await downloadBerichtPdf(titel, zeitraum, firma, tabelle(), `${dateiBasis}.pdf`) }
    catch (e) { setExportFehler(e instanceof Error ? e.message : 'PDF fehlgeschlagen') }
  }
  // Drucken: PDF-Vorschau mit „Drucken" (wie bei den Berichten)
  const drucken = async () => {
    try { setVorschauUrl(await berichtPdfVorschauUrl(titel, zeitraum, firma, tabelle())) }
    catch (e) { setExportFehler(e instanceof Error ? e.message : 'Druckansicht fehlgeschlagen') }
  }
  const schliesseVorschau = () => {
    if (vorschauUrl) URL.revokeObjectURL(vorschauUrl)
    setVorschauUrl(null)
  }
  const knopf = 'px-3 py-1.5 rounded-lg border border-line-strong text-sm font-medium text-ink hover:bg-panel-2 transition disabled:opacity-50'

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <PdfVorschauModal url={vorschauUrl} titel={titel} dateiname={`${dateiBasis}.pdf`} onClose={schliesseVorschau} />
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-2xl font-bold text-ink">Lagerstand-Übersicht</h1>
        <div className="flex gap-2">
          <button type="button" className={knopf} disabled={angezeigt.length === 0} onClick={() => ladeCsvHerunter(alsCsv(tabelle()), `${dateiBasis}.csv`)} data-testid="lager-csv">CSV-Export</button>
          <button type="button" className={knopf} disabled={angezeigt.length === 0} onClick={() => { void pdf() }} data-testid="lager-pdf">PDF</button>
          <button type="button" className={knopf} disabled={angezeigt.length === 0} onClick={() => { void drucken() }} data-testid="lager-drucken">Drucken</button>
        </div>
      </div>
      {exportFehler && <p className="mb-3 text-sm text-red-600" role="alert">{exportFehler}</p>}

      {/* Warengruppe in Lager aufnehmen */}
      <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-4">
        <p className="text-sm font-semibold text-brand-800 mb-3">
          Warengruppe in Lagerführung aufnehmen
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={gewaehlteKategorie}
            onChange={e => setGewaehlteKategorie(e.target.value)}
            className="flex-1 min-w-40 rounded-lg border border-brand-300 bg-panel px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="alle">Alle Artikel (ohne Kategorie)</option>
            {baumFlach(kategorienQuery.data ?? []).map(({ kategorie: k }) => (
              <option key={k.id} value={k.id}>{kategoriePfad(kategorienQuery.data ?? [], k.id)}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={lagerAktivierenMutation.isPending}
            onClick={() => lagerAktivierenMutation.mutate(gewaehlteKategorie === 'alle' ? null : gewaehlteKategorie)}
            className="shrink-0 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-60 transition"
          >
            {lagerAktivierenMutation.isPending ? 'Wird aktiviert…' : 'Lager aktivieren'}
          </button>
        </div>
        {lagerAktivierenMutation.isSuccess && (
          <p className="mt-2 text-xs text-brand-700">
            ✓ {lagerAktivierenMutation.data.aktiviert} Artikel in Lagerführung aufgenommen.
          </p>
        )}
        {lagerAktivierenMutation.isError && (
          <p className="mt-2 text-xs text-red-600">
            Fehler: {lagerAktivierenMutation.error instanceof Error ? lagerAktivierenMutation.error.message : 'Unbekannt'}
          </p>
        )}
      </div>

      {/* Statistik-Kacheln */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatKachel label="Artikel gesamt" wert={stats.gesamt}    farbe="gray" />
        <StatKachel label="OK"             wert={stats.ok}        farbe="green" />
        <StatKachel label="Niedrig"        wert={stats.niedrig}   farbe="yellow" />
        <StatKachel label="Kritisch"       wert={stats.kritisch}  farbe="red" />
      </div>

      {/* Filter + Suche */}
      <div className="flex gap-3 mb-4">
        <div className="flex rounded-lg border border-line overflow-hidden">
          <FilterBtn active={filter === 'alle'}  onClick={() => setFilter('alle')}>Alle</FilterBtn>
          <FilterBtn active={filter === 'alarm'} onClick={() => setFilter('alarm')}>
            Alarm
            {(stats.niedrig + stats.kritisch) > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold">
                {stats.niedrig + stats.kritisch}
              </span>
            )}
          </FilterBtn>
        </div>
        <input
          type="text"
          placeholder="Suche…"
          value={suche}
          onChange={e => setSuche(e.target.value)}
          className="flex-1 px-3 py-1.5 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-4 text-sm text-ink-muted">
        <label className="flex items-center gap-2">
          Reichweite aus dem Verbrauch der letzten
          <input
            type="number" min={1} max={365} value={tage} data-testid="lager-tage"
            onChange={e => { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= 365) setTage(n) }}
            className="w-16 text-right border border-line-strong rounded-md px-2 py-1 text-sm font-semibold text-ink bg-panel focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          Tage
        </label>
        <label className="flex items-center gap-2">
          Sortieren nach
          <select
            value={sortierung} onChange={e => setSortierung(e.target.value as 'status' | 'reichweite')} data-testid="lager-sortierung"
            className="rounded-md border border-line-strong bg-panel px-2 py-1 text-sm text-ink"
          >
            <option value="status">Status</option>
            <option value="reichweite">Reichweite (kürzeste zuerst)</option>
          </select>
        </label>
      </div>

      {/* Tabelle */}
      {isLoading ? (
        <p className="text-ink-muted text-sm">Lade…</p>
      ) : angezeigt.length === 0 ? (
        <div className="text-center py-16 text-ink-muted">
          {lagerArtikel.length === 0
            ? 'Keine Artikel mit aktivem Lagerstand. Lagerstand-Tracking kann in der Artikelverwaltung aktiviert werden.'
            : 'Kein Artikel entspricht dem Filter.'}
        </div>
      ) : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-panel-2 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Artikel</th>
                <th className="px-4 py-3 text-right">Lagerstand</th>
                <th className="px-4 py-3 text-right">Mindestbestand</th>
                <th className="px-3 py-3 text-right">Ø/Tag</th>
                <th className="px-3 py-3 text-right" title="Erwartete Reichweite des Lagerstands beim Ø-Verbrauch">Reicht</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {angezeigt.map((a, idx) => {
                const st = lagerStatus(a)
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-line last:border-0 ${idx % 2 === 0 ? 'bg-panel' : 'bg-panel-2/40'}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[st]}`} />
                        <span className="font-medium text-ink">{a.bezeichnung}</span>
                        {a.artikelnummer && (
                          <span className="text-xs text-ink-subtle">#{a.artikelnummer}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">
                      <span className={
                        st === 'kritisch' ? 'text-red-600' :
                        st === 'niedrig'  ? 'text-yellow-600' :
                        'text-ink'
                      }>
                        {a.lagerstandMenge !== null && a.lagerstandMenge !== undefined
                          ? a.lagerstandMenge
                          : <span className="text-red-500">–</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MindestbestandCell
                        artikel={a}
                        onSave={(id, mindestbestand) => updateMutation.mutate({ id, mindestbestand })}
                      />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-ink-muted" data-testid="lager-pro-tag">
                      {verbrauch.has(a.id) ? zahl(verbrauch.get(a.id)!.verbrauchProTag) : '…'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono" data-testid="lager-reicht">
                      {(() => {
                        const v = verbrauch.get(a.id)
                        if (!v) return <span className="text-ink-subtle">…</span>
                        if (v.reichtTageBestand === null) return <span className="text-ink-subtle" title="Kein Verbrauch im Zeitraum">–</span>
                        return (
                          <span className={reichweiteFarbe(v.reichtTageBestand, tage)}>
                            {zahl(v.reichtTageBestand)} T
                            {v.unterwegs > 0 && v.reichtTage !== null && (
                              <span className="block text-[11px] font-normal text-ink-muted">mit Bestellung {zahl(v.reichtTage)} T</span>
                            )}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${STATUS_FARBE[st]}`}>
                        {STATUS_LABEL[st]}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-ink-subtle">
        Tipp: Klicke auf den Mindestbestand-Wert, um ihn direkt zu bearbeiten. Leerlassen = kein Alarm.
        „Reicht" = Lagerstand ÷ Ø-Verbrauch je Tag (Verkäufe minus Stornos, Rohstoffe über die Rezepturen).
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfkomponenten
// ---------------------------------------------------------------------------

function StatKachel({ label, wert, farbe }: { label: string; wert: number; farbe: 'gray' | 'green' | 'yellow' | 'red' }) {
  const farbKlasse = {
    gray:   'border-line bg-panel-2',
    green:  'border-green-200 bg-green-50',
    yellow: 'border-yellow-200 bg-yellow-50',
    red:    'border-red-200 bg-red-50',
  }[farbe]
  const textKlasse = {
    gray:   'text-ink',
    green:  'text-green-700',
    yellow: 'text-yellow-700',
    red:    'text-red-700',
  }[farbe]

  return (
    <div className={`rounded-xl border p-4 ${farbKlasse}`}>
      <p className={`text-2xl font-bold ${textKlasse}`}>{wert}</p>
      <p className="text-xs text-ink-muted mt-0.5">{label}</p>
    </div>
  )
}

function FilterBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-4 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-brand-600 text-white'
          : 'bg-panel text-ink-muted hover:bg-panel-2'
      }`}
    >
      {children}
    </button>
  )
}
