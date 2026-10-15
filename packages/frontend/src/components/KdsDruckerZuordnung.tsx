/**
 * KdsDruckerZuordnung — welcher Bonierdrucker druckt die KDS-Bons je Station, welcher Backup-Drucker springt
 * dort ein, plus fester Fallback für alle.
 *
 * Steht unter Einstellungen → Kassen & Drucker (Abschnitt „KDS-Stationen").
 *
 * - Station → Drucker: Erledigt-Bon, Teilbon und Nachdrucken gehen NUR an den gewählten Drucker
 *   (ohne Auswahl: jeder aktive Bonierdrucker, wie früher).
 * - Backup-Drucker: der eigene Ersatz des gewählten Druckers — ist er nicht erreichbar, druckt der Bon dort.
 *   Gilt für alles, was der Drucker druckt (auch Bonieren), nicht nur für diese Station. Hier ist auch der als
 *   „Backup" (Zweitdrucker) markierte Drucker wählbar.
 * - Fallback: scheitert ein Druck am vorgesehenen Drucker (und an dessen Backup-Drucker), geht der
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
  const backupSetzen = useMutation({
    mutationFn: ({ druckerId, backupId }: { druckerId: string; backupId: string | null }) =>
      bonierdruckerApi.update(druckerId, { fallbackId: backupId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bonierdrucker'] })
      void queryClient.invalidateQueries({ queryKey: ['einrichtung'] })
    },
    onError,
  })
  const fallbackSetzen = useMutation({
    mutationFn: (id: string | null) => kdsDruckerApi.fallbackSetzen(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['kds-fallback-drucker'] }) },
    onError,
  })

  const optionen = (liste: typeof alleDrucker) => liste.map(d => (
    <option key={d.id} value={d.id}>
      {d.name} ({d.ip}){d.istBackup ? ' – Zweitdrucker' : ''}{d.aktiv ? '' : ' – deaktiviert'}
    </option>
  ))

  return (
    <div id="einrichtung-kds" className="rounded-xl border border-line bg-panel p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-ink">KDS-Drucker je Station</p>
        <p className="text-xs text-ink-muted mt-0.5">
          Der Papierbon beim Erledigen, beim Teilbon und beim Nachdrucken geht nur an den hier gewählten Drucker.
          Ohne Auswahl druckt jeder aktive Bonierdrucker (wie bisher). Der <strong>Backup-Drucker</strong> springt ein, wenn der
          Stationsdrucker nicht erreichbar ist. Drucker legst du oben bei „Drucker" an.
        </p>
      </div>

      {!druckerQuery.isLoading && hauptDrucker.length === 0 && (
        <p className="text-xs text-amber-700">Noch kein Bonierdrucker angelegt — bitte zuerst oben bei „Drucker" einrichten.</p>
      )}

      <div className="space-y-2">
        {ALLE_STATIONEN.map(s => {
          const gewaehlt = druckerFuer(s)
          const drucker  = hauptDrucker.find(d => d.id === gewaehlt)
          const backupId = drucker?.fallbackId ?? ''
          const backup   = alleDrucker.find(d => d.id === backupId)
          return (
            <div key={s} data-testid={`kds-station-${s}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="w-24 shrink-0 font-medium text-ink">{STATION_LABELS[s]}</span>
              <select
                value={gewaehlt}
                disabled={stationSetzen.isPending}
                onChange={e => { setFehler(null); stationSetzen.mutate({ station: s, id: e.target.value || null }) }}
                className="min-w-[12rem] flex-1 rounded-md border border-line bg-panel px-2 py-1 text-sm"
                aria-label={`Drucker für ${STATION_LABELS[s]}`}
              >
                <option value="">Alle aktiven Drucker (wie bisher)</option>
                {optionen(hauptDrucker)}
              </select>
              <select
                value={backupId}
                // Der Backup-Drucker gehört zum gewählten Drucker — ohne Stationsdrucker gibt es nichts, dem er zugeordnet wäre
                disabled={!drucker || backupSetzen.isPending}
                onChange={e => { setFehler(null); if (drucker) backupSetzen.mutate({ druckerId: drucker.id, backupId: e.target.value || null }) }}
                className="min-w-[12rem] flex-1 rounded-md border border-line bg-panel px-2 py-1 text-sm disabled:opacity-60"
                aria-label={`Backup-Drucker für ${STATION_LABELS[s]}`}
                title={drucker ? 'Springt ein, wenn der Stationsdrucker nicht erreichbar ist' : 'Zuerst einen Drucker für diese Station wählen'}
              >
                <option value="">{drucker ? 'Kein Backup-Drucker' : '— erst Drucker wählen —'}</option>
                {optionen(alleDrucker.filter(d => d.id !== drucker?.id))}
              </select>
              {drucker && !drucker.aktiv && <span className="text-[11px] text-red-600 shrink-0">druckt nicht</span>}
              {backup && !backup.aktiv && <span className="text-[11px] text-red-600 shrink-0">Backup druckt nicht (deaktiviert)</span>}
            </div>
          )
        })}
      </div>

      {/* Fester Fallback: übernimmt, wenn ein Druck auf dem vorgesehenen Drucker (und dessen Backup) scheitert */}
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
          Scheitert ein Bondruck am vorgesehenen Drucker (und an dessen Backup-Drucker), geht der Bon sofort an
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
