import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Artikel } from '@kassa/shared'
import { artikelApi, kategorieApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'

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
  unbekannt: 'bg-gray-100 text-gray-600 border-gray-200',
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
      className="min-w-[4rem] px-2 py-0.5 text-sm text-right rounded hover:bg-gray-100 border border-transparent hover:border-gray-300 transition"
      title="Klicken zum Bearbeiten"
    >
      {artikel.mindestbestand !== null && artikel.mindestbestand !== undefined
        ? artikel.mindestbestand
        : <span className="text-gray-400 italic">–</span>}
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

  const { data: alleArtikel = [], isLoading } = useQuery({
    queryKey: ['artikel', auth?.mandant.id, 'alle'],
    queryFn:  () => artikelApi.list(auth!.mandant.id, false),
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
      // Kritisch zuerst, dann Niedrig, dann OK
      const prio: Record<LagerStatus, number> = { kritisch: 0, niedrig: 1, ok: 2, unbekannt: 3 }
      const diff = prio[lagerStatus(a)] - prio[lagerStatus(b)]
      if (diff !== 0) return diff
      return a.bezeichnung.localeCompare(b.bezeichnung)
    })

  const kategorienQuery = useQuery({
    queryKey: ['kategorien', identity?.kasseId],
    queryFn:  () => kategorieApi.list(),
    enabled:  !!identity,
  })

  const [gewaehlteKategorie, setGewaehlteKategorie] = useState<string>('alle')

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Lagerstand-Übersicht</h1>

      {/* Warengruppe in Lager aufnehmen */}
      <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-4">
        <p className="text-sm font-semibold text-brand-800 mb-3">
          Warengruppe in Lagerführung aufnehmen
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={gewaehlteKategorie}
            onChange={e => setGewaehlteKategorie(e.target.value)}
            className="flex-1 min-w-40 rounded-lg border border-brand-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="alle">Alle Artikel (ohne Kategorie)</option>
            {(kategorienQuery.data ?? []).map(k => (
              <option key={k.id} value={k.id}>{k.name}</option>
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
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
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
          className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Tabelle */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">Lade…</p>
      ) : angezeigt.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          {lagerArtikel.length === 0
            ? 'Keine Artikel mit aktivem Lagerstand. Lagerstand-Tracking kann in der Artikelverwaltung aktiviert werden.'
            : 'Kein Artikel entspricht dem Filter.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Artikel</th>
                <th className="px-4 py-3 text-right">Lagerstand</th>
                <th className="px-4 py-3 text-right">Mindestbestand</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {angezeigt.map((a, idx) => {
                const st = lagerStatus(a)
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[st]}`} />
                        <span className="font-medium text-gray-900">{a.bezeichnung}</span>
                        {a.artikelnummer && (
                          <span className="text-xs text-gray-400">#{a.artikelnummer}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">
                      <span className={
                        st === 'kritisch' ? 'text-red-600' :
                        st === 'niedrig'  ? 'text-yellow-600' :
                        'text-gray-900'
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

      <p className="mt-4 text-xs text-gray-400">
        Tipp: Klicke auf den Mindestbestand-Wert, um ihn direkt zu bearbeiten. Leerlassen = kein Alarm.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfkomponenten
// ---------------------------------------------------------------------------

function StatKachel({ label, wert, farbe }: { label: string; wert: number; farbe: 'gray' | 'green' | 'yellow' | 'red' }) {
  const farbKlasse = {
    gray:   'border-gray-200 bg-gray-50',
    green:  'border-green-200 bg-green-50',
    yellow: 'border-yellow-200 bg-yellow-50',
    red:    'border-red-200 bg-red-50',
  }[farbe]
  const textKlasse = {
    gray:   'text-gray-700',
    green:  'text-green-700',
    yellow: 'text-yellow-700',
    red:    'text-red-700',
  }[farbe]

  return (
    <div className={`rounded-xl border p-4 ${farbKlasse}`}>
      <p className={`text-2xl font-bold ${textKlasse}`}>{wert}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
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
          : 'bg-white text-gray-600 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}
