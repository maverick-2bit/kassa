import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALLE_STATIONEN,
  STATION_LABELS,
  nachkommenIds,
  wirksamesKategorieRouting,
  type Artikel,
  type Station,
} from '@kassa/shared'
import { baumFlach, kategoriePfad } from '../lib/kategorie-baum'
import { artikelApi, kategorieApi } from '../lib/api'
import { getAuth } from '../lib/auth'

/**
 * KDS-Zuordnung: Übersicht aller Artikel mit ihrer eigenen KDS-Station.
 *
 * Normalfall: Die Station steht an der Warengruppe (und gilt für deren Untergruppen) —
 * der Artikel steht dann auf "Automatisch". Nur Artikel, die von ihrer Gruppe abweichen
 * sollen, bekommen hier eine eigene Station. Mit "Auf Warengruppe zurücksetzen" folgen
 * Artikel wieder ihrer Gruppe, auch wenn vorher etwas anderes eingestellt war.
 */

type Zeigen = 'alle' | 'eigene' | 'ohne'

export function KdsZuordnungPage() {
  const auth        = getAuth()
  const queryClient = useQueryClient()

  const [suche, setSuche]       = useState('')
  const [katFilter, setKatFilter] = useState<string>('alle')
  const [zeigen, setZeigen]     = useState<Zeigen>('alle')
  const [auswahl, setAuswahl]   = useState<Set<string>>(new Set())
  const [meldung, setMeldung]   = useState<{ ok: boolean; text: string } | null>(null)

  const artikelQuery = useQuery({
    queryKey: ['artikel', auth?.mandant.id, true],
    queryFn:  () => artikelApi.list(auth!.mandant.id, true),
    enabled:  !!auth,
  })
  const kategorienQuery = useQuery({
    queryKey: ['kategorien', 'kds-zuordnung'],
    queryFn:  () => kategorieApi.list(true),
  })
  const kategorien = kategorienQuery.data ?? []

  // Wirksame Station der Warengruppe (inkl. geerbt von der Elterngruppe)
  const routing = useMemo(() => wirksamesKategorieRouting(kategorien), [kategorien])
  const gruppenStation = (a: Artikel): Station | null =>
    a.kategorieId ? ((routing.get(a.kategorieId)?.station as Station | null | undefined) ?? null) : null
  const wirksameStation = (a: Artikel): Station | null => a.station ?? gruppenStation(a)

  // Rohstoffe/Bestandteile werden nie geboniert
  const alle = useMemo(
    () => (artikelQuery.data ?? []).filter(a => !a.istBestandteil),
    [artikelQuery.data],
  )

  const katIdsImFilter = useMemo(
    () => katFilter === 'alle' ? null : new Set([katFilter, ...nachkommenIds(kategorien, katFilter)]),
    [katFilter, kategorien],
  )

  const angezeigt = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return alle
      .filter(a => !katIdsImFilter || (a.kategorieId !== null && katIdsImFilter.has(a.kategorieId)))
      .filter(a => !q || a.bezeichnung.toLowerCase().includes(q))
      .filter(a => zeigen === 'alle' || (zeigen === 'eigene' ? a.station !== null : wirksameStation(a) === null))
      .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alle, katIdsImFilter, suche, zeigen, routing])

  const stats = {
    gesamt: alle.length,
    eigene: alle.filter(a => a.station !== null).length,
    ohne:   alle.filter(a => wirksameStation(a) === null).length,
  }

  const setzen = useMutation({
    mutationFn: ({ id, station }: { id: string; station: Station | null }) =>
      artikelApi.update(id, { station }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['artikel'] }) },
    onError: (err) => setMeldung({ ok: false, text: err instanceof Error ? err.message : 'Speichern fehlgeschlagen' }),
  })

  const zuruecksetzen = useMutation({
    mutationFn: (ids: string[]) => artikelApi.kdsZuruecksetzen(ids),
    onSuccess: (r) => {
      setMeldung({ ok: true, text: `${r.zurueckgesetzt} Artikel folgen jetzt ihrer Warengruppe.` })
      setAuswahl(new Set())
      void queryClient.invalidateQueries({ queryKey: ['artikel'] })
    },
    onError: (err) => setMeldung({ ok: false, text: err instanceof Error ? err.message : 'Zurücksetzen fehlgeschlagen' }),
  })

  const markierte = angezeigt.filter(a => auswahl.has(a.id))
  const alleMarkiert = angezeigt.length > 0 && markierte.length === angezeigt.length
  const toggle = (id: string) =>
    setAuswahl(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const alleToggle = () =>
    setAuswahl(alleMarkiert ? new Set() : new Set(angezeigt.map(a => a.id)))

  /** Nur Artikel mit eigener Einstellung müssen überhaupt geändert werden. */
  const zuruecksetzenMit = (liste: Artikel[], beschreibung: string) => {
    const betroffen = liste.filter(a => a.station !== null)
    if (betroffen.length === 0) { setMeldung({ ok: true, text: 'Nichts zu tun — alle folgen schon ihrer Warengruppe.' }); return }
    if (!window.confirm(`${betroffen.length} Artikel (${beschreibung}) auf die Einstellung ihrer Warengruppe zurücksetzen?\n\nIhre eigene KDS-Station wird dabei entfernt, auch wenn sie abweicht.`)) return
    setMeldung(null)
    zuruecksetzen.mutate(betroffen.map(a => a.id))
  }

  const stationName = (s: Station | null) => (s ? STATION_LABELS[s] : 'keine')
  const laedt = artikelQuery.isLoading || kategorienQuery.isLoading

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-ink mb-1">KDS-Zuordnung</h1>
      <p className="text-sm text-ink-muted mb-4">
        Die Station wird an der <strong>Warengruppe</strong> eingestellt und gilt für alle ihre Untergruppen.
        Hier siehst du, welche Artikel eine <strong>eigene</strong> Station haben und damit von der Gruppe abweichen.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Kachel label="Artikel" wert={stats.gesamt} />
        <Kachel label="Mit eigener Station" wert={stats.eigene} />
        <Kachel label="Ohne Station (kein KDS)" wert={stats.ohne} warn={stats.ohne > 0} />
      </div>

      {/* Aktionen */}
      <div className="mb-4 rounded-xl border border-brand-200 bg-brand-50 p-4 space-y-3">
        <p className="text-sm font-semibold text-brand-800">Auf Warengruppe zurücksetzen</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={markierte.length === 0 || zuruecksetzen.isPending}
            onClick={() => zuruecksetzenMit(markierte, 'markierte')}
            className="px-3 py-2 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 transition"
          >
            Markierte ({markierte.length})
          </button>
          <button
            type="button"
            disabled={angezeigt.length === 0 || zuruecksetzen.isPending}
            onClick={() => zuruecksetzenMit(angezeigt, 'alle angezeigten')}
            className="px-3 py-2 rounded-lg border border-brand-300 bg-panel text-brand-800 text-sm font-semibold hover:bg-brand-100 disabled:opacity-50 transition"
          >
            Alle angezeigten ({angezeigt.length})
          </button>
        </div>
        <p className="text-xs text-brand-700">
          Wirkt auch bei Artikeln, die aktuell eine andere Station haben. „Alle angezeigten“ richtet sich nach Suche und
          Filter — ohne Filter sind das alle Artikel.
        </p>
        {meldung && (
          <p className={`text-xs ${meldung.ok ? 'text-emerald-700' : 'text-red-600'}`}>{meldung.text}</p>
        )}
      </div>

      {/* Filter */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          placeholder="Artikel suchen…"
          value={suche}
          onChange={e => setSuche(e.target.value)}
          className="flex-1 min-w-40 px-3 py-1.5 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={katFilter}
          onChange={e => setKatFilter(e.target.value)}
          className="px-3 py-1.5 border border-line rounded-lg text-sm bg-panel"
          aria-label="Warengruppe"
        >
          <option value="alle">Alle Warengruppen</option>
          {baumFlach(kategorien).map(({ kategorie: k }) => (
            <option key={k.id} value={k.id}>{kategoriePfad(kategorien, k.id)}</option>
          ))}
        </select>
        <select
          value={zeigen}
          onChange={e => setZeigen(e.target.value as Zeigen)}
          className="px-3 py-1.5 border border-line rounded-lg text-sm bg-panel"
          aria-label="Anzeige"
        >
          <option value="alle">Alle Artikel</option>
          <option value="eigene">Nur mit eigener Station</option>
          <option value="ohne">Nur ohne Station (kein KDS)</option>
        </select>
      </div>

      {laedt ? (
        <p className="text-sm text-ink-muted">Lade…</p>
      ) : angezeigt.length === 0 ? (
        <div className="text-center py-16 text-ink-muted text-sm">Kein Artikel entspricht dem Filter.</div>
      ) : (
        <div className="bg-panel border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-panel-2 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                <th className="px-3 py-3 w-10">
                  <input type="checkbox" checked={alleMarkiert} onChange={alleToggle} aria-label="Alle angezeigten markieren" />
                </th>
                <th className="px-3 py-3 text-left">Artikel</th>
                <th className="px-3 py-3 text-left">Warengruppe</th>
                <th className="px-3 py-3 text-left">Station der Gruppe</th>
                <th className="px-3 py-3 text-left">Eigene Station</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {angezeigt.map(a => {
                const gruppe   = gruppenStation(a)
                const wirksam  = wirksameStation(a)
                const abweich  = a.station !== null && a.station !== gruppe
                const speichert = setzen.isPending && setzen.variables?.id === a.id
                return (
                  <tr key={a.id} className={`hover:bg-panel-2 ${wirksam === null ? 'bg-amber-50/60' : ''}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={auswahl.has(a.id)} onChange={() => toggle(a.id)} aria-label={`${a.bezeichnung} markieren`} />
                    </td>
                    <td className="px-3 py-2 font-medium text-ink">{a.bezeichnung}</td>
                    <td className="px-3 py-2 text-ink-muted">
                      {a.kategorieId ? kategoriePfad(kategorien, a.kategorieId) : <span className="italic text-ink-subtle">ohne Warengruppe</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{stationName(gruppe)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={a.station ?? ''}
                          disabled={speichert}
                          onChange={e => {
                            setMeldung(null)
                            setzen.mutate({ id: a.id, station: (e.target.value || null) as Station | null })
                          }}
                          aria-label={`KDS-Station für ${a.bezeichnung}`}
                          className={`rounded-md border px-2 py-1 text-sm bg-panel ${abweich ? 'border-amber-400' : 'border-line'}`}
                        >
                          <option value="">Automatisch ({stationName(gruppe)})</option>
                          {ALLE_STATIONEN.map(s => (
                            <option key={s} value={s}>{STATION_LABELS[s]}</option>
                          ))}
                        </select>
                        {abweich && <span className="text-[11px] text-amber-700">weicht ab</span>}
                        {wirksam === null && <span className="text-[11px] text-red-600">kein KDS</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Kachel({ label, wert, warn = false }: { label: string; wert: number; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${warn ? 'border-amber-300 bg-amber-50' : 'border-line bg-panel'}`}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-bold text-ink">{wert}</p>
    </div>
  )
}
