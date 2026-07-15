/**
 * DruckerStatusLed — farbige Online-Anzeige pro Drucker (grün = online,
 * rot = offline, grau = unbekannt). Prüft alle 30s per TCP-Erreichbarkeit.
 * Wiederverwendet in der Bondrucker- und Bonierdrucker-Bibliothek.
 */

import { useQuery } from '@tanstack/react-query'
import type { DruckerStatus } from '../lib/api'

export function DruckerStatusLed({ druckerId, fetchStatus }: {
  druckerId:   string
  fetchStatus: (id: string) => Promise<DruckerStatus>
}) {
  const q = useQuery({
    queryKey:        ['drucker-status-led', druckerId],
    queryFn:         () => fetchStatus(druckerId),
    refetchInterval: 30_000,
    staleTime:       25_000,
  })

  const online = q.data?.online
  const { dot, label } =
    q.isLoading         ? { dot: 'bg-gray-300 animate-pulse', label: 'prüfe…' } :
    online === true     ? { dot: 'bg-green-500 shadow-[0_0_6px] shadow-green-400/70', label: 'Online' } :
    online === false    ? { dot: 'bg-red-500',   label: 'Offline' } :
                          { dot: 'bg-gray-300',  label: 'unbekannt' }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted shrink-0" title={`Drucker ${label}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}
