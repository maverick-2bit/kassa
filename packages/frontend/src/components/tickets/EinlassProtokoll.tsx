import { useQuery } from '@tanstack/react-query'
import { EINLASS_ERGEBNIS_TITEL, EINLASS_ZUGELASSEN, ticketTitel, type TicketEventDetail } from '@kassa/shared'
import { ticketingApi } from '../../lib/api'

const ZEIT = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * Jeder Scan am Eingang — auch die abgewiesenen. Beantwortet die Frage
 * „warum wurde ich nicht reingelassen?" und zeigt Kopien (zweiter Scan
 * desselben Codes an anderem Gerät). Offline geprüfte Scans kommen mit dem
 * Zeitpunkt am Eingang nach; ein KONFLIKT heißt: offline eingelassen, obwohl
 * das Ticket woanders schon eingelöst (oder storniert) war.
 */
export function EinlassProtokoll({ event }: { event: TicketEventDetail }) {
  const { data: log = [], isLoading } = useQuery({
    queryKey: ['einlass-log', event.id],
    queryFn:  () => ticketingApi.einlassLog(event.id),
    refetchInterval: 10_000,
  })

  if (isLoading) return <p className="text-sm text-ink-muted">Lädt…</p>
  if (log.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong py-10 text-center text-sm text-ink-muted">
        Noch keine Scans. Einlass-Geräte richtest du unter „Alle Events“ → Einlass-Geräte ein.
      </div>
    )
  }

  const konflikte = log.filter(l => l.konflikt).length
  return (
    <div className="space-y-3">
      {konflikte > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          ⚠ {konflikte} {konflikte === 1 ? 'Konflikt' : 'Konflikte'} aus dem Offline-Betrieb: Gäste wurden ohne Verbindung
          eingelassen, obwohl ihr Ticket schon woanders eingelöst oder storniert war — meist eine Ticket-Kopie an einem
          zweiten Eingang.
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="px-3 py-2">Zeit</th>
              <th className="px-3 py-2">Gerät</th>
              <th className="px-3 py-2">Ergebnis</th>
              <th className="px-3 py-2">Ticket</th>
            </tr>
          </thead>
          <tbody>
            {log.map(l => {
              const ok = EINLASS_ZUGELASSEN.has(l.ergebnis)
              return (
                <tr key={l.id} className={`border-b border-line last:border-0 ${l.konflikt ? 'bg-amber-50' : ''}`}>
                  <td className="px-3 py-1.5 tabular-nums text-ink-muted">{ZEIT.format(new Date(l.zeitpunkt))}</td>
                  <td className="px-3 py-1.5 text-ink">
                    {l.geraetName ?? '—'}
                    {l.offline && <span className="ml-1.5 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">offline</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {l.konflikt ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                        ⚠ offline eingelassen · {EINLASS_ERGEBNIS_TITEL[l.ergebnis]}
                      </span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>
                        {EINLASS_ERGEBNIS_TITEL[l.ergebnis]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {l.ticket
                      ? <span className="text-ink">{ticketTitel(l.ticket)}{l.ticket.name ? <span className="text-ink-muted"> · {l.ticket.name}</span> : null}</span>
                      : <span className="font-mono text-[11px] text-ink-subtle">{l.code}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
