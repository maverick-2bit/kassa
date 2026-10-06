/**
 * KdsDruckerZuordnung — welcher Bonierdrucker druckt die KDS-Bons je Station, plus fester Fallback.
 *
 * Wird an zwei Stellen gezeigt (Einstellungen → Hardware unter der Drucker-Bibliothek und
 * KDS-Zuordnung) und liest/schreibt dieselben Daten — eine Änderung ist sofort an beiden sichtbar.
 *
 * - Station → Drucker: Erledigt-Bon, Teilbon und Nachdrucken gehen NUR an den gewählten Drucker
 *   (ohne Auswahl: jeder aktive Bonierdrucker, wie früher).
 * - Fallback: scheitert ein Druck am vorgesehenen Drucker (und an dessen eigenem Ersatz), geht der
 *   Bon an diesen Drucker — damit kein Bon verloren geht.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ALLE_STATIONEN, STATION_LABELS, type Station } from '@kassa/shared'
import { bonierdruckerApi, kdsDruckerApi } from '../lib/api'

export function KdsDruckerZuordnung() {
  const queryClient = useQueryClient()
  const [fehler, setFehler] = useState<string | null>(null)

  const druckerQuery        = useQuery({ queryKey: ['bonierdrucker'],         queryFn: () => bonierdruckerApi.list() })
  const stationDruckerQuery = useQuery({ queryKey: ['kds-station-drucker'],   queryFn: () => kdsDruckerApi.list() })
  const fallbackQuery       = useQuery({ queryKey: ['kds-fallback-drucker'],  queryFn: () => kdsDruckerApi.fallback() })

  const alleDrucker  = druckerQuery.data ?? []
  const hauptDrucker = alleDrucker.filter(d => !d.istBackup)
  const druckerFuer  = (s: Station) =>
    stationDruckerQuery.data?.eintraege.find(e => e.station === s)?.bonierdruckerId ?? ''
  const fallbackId   = fallbackQuery.data?.bonierdruckerId ?? ''

  const onError = (err: unknown) => setFehler(err instanceof Error ? err.message : 'Speichern fehlgeschlagen')

  const stationSetzen = useMutation({
    mutationFn: ({ station, id }: { station: Station; id: string | null }) => kdsDruckerApi.setzen(station, id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['kds-station-drucker'] }) },
    onError,
  })
  const fallbackSetzen = useMutation({
    mutationFn: (id: string | null) => kdsDruckerApi.fallbackSetzen(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['kds-fallback-drucker'] }) },
    onError,
  })

  const optionen = (liste: typeof alleDrucker) => liste.map(d => (
    <option key={d.id} value={d.id}>
      {d.name} ({d.ip}){d.aktiv ? '' : ' – deaktiviert'}
    </option>
  ))

  return (
    <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-ink">KDS-Drucker je Station</p>
        <p className="text-xs text-ink-muted mt-0.5">
          Der Papierbon beim Erledigen, beim Teilbon und beim Nachdrucken geht nur an den hier gewählten Drucker.
          Ohne Auswahl druckt jeder aktive Bonierdrucker (wie bisher). Drucker legst du oben in der Bonierdrucker-Bibliothek an.
        </p>
      </div>

      {!druckerQuery.isLoading && hauptDrucker.length === 0 && (
        <p className="text-xs text-amber-700">Noch kein Bonierdrucker angelegt — bitte zuerst in der Bonierdrucker-Bibliothek einrichten.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {ALLE_STATIONEN.map(s => {
          const gewaehlt = druckerFuer(s)
          const drucker  = hauptDrucker.find(d => d.id === gewaehlt)
          return (
            <label key={s} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 font-medium text-ink">{STATION_LABELS[s]}</span>
              <select
                value={gewaehlt}
                disabled={stationSetzen.isPending}
                onChange={e => { setFehler(null); stationSetzen.mutate({ station: s, id: e.target.value || null }) }}
                className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-sm"
                aria-label={`Drucker für ${STATION_LABELS[s]}`}
              >
                <option value="">Alle aktiven Drucker (wie bisher)</option>
                {optionen(hauptDrucker)}
              </select>
              {drucker && !drucker.aktiv && <span className="text-[11px] text-red-600 shrink-0">druckt nicht</span>}
            </label>
          )
        })}
      </div>

      {/* Fester Fallback: übernimmt, wenn ein Druck auf dem vorgesehenen Drucker scheitert */}
      <div className="border-t border-line pt-3">
        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-24 shrink-0 font-semibold text-ink">Fallback</span>
          <select
            value={fallbackId}
            disabled={fallbackSetzen.isPending}
            onChange={e => { setFehler(null); fallbackSetzen.mutate(e.target.value || null) }}
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-sm"
            aria-label="Fallback-Drucker"
          >
            <option value="">Kein fester Fallback</option>
            {optionen(alleDrucker)}
          </select>
        </label>
        <p className="mt-1 text-xs text-ink-muted">
          Scheitert ein Bondruck am vorgesehenen Drucker (und an dessen eigenem Ersatzdrucker), geht der Bon sofort an
          diesen Drucker — so geht kein Bon verloren. Gilt für das Bonieren, den Erledigt-Bon, den Teilbon und das Nachdrucken.
          {fallbackId && !alleDrucker.some(d => d.id === fallbackId && d.aktiv) && (
            <span className="text-red-600"> Der gewählte Fallback-Drucker ist deaktiviert und greift nicht.</span>
          )}
        </p>
      </div>

      {fehler && <p className="text-xs text-red-600">{fehler}</p>}
    </div>
  )
}
