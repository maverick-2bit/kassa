import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TICKET_BESTELLUNG_STATUS_LABELS, type TicketBestellungStatus, type TicketEventDetail } from '@kassa/shared'
import { ticketingApi } from '../../lib/api'
import { formatPreis } from '../../lib/format'
import { fehlerText } from '../../lib/ticketing'

const ZEIT = new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const STATUS_STIL: Record<TicketBestellungStatus, string> = {
  zahlung:     'bg-amber-50 text-amber-800',
  finalisiere: 'bg-amber-50 text-amber-800',
  bezahlt:     'bg-green-50 text-green-800',
  abgelaufen:  'bg-panel-2 text-ink-muted',
  abgebrochen: 'bg-panel-2 text-ink-muted',
}

/**
 * Online-Bestellungen eines Events — auch abgebrochene und abgelaufene, damit
 * die Frage „ich habe bezahlt, wo sind meine Tickets?" beantwortbar ist.
 */
export function TicketBestellungen({ event }: { event: TicketEventDetail }) {
  const qc = useQueryClient()
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null)
  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['ticket-bestellungen', event.id],
    queryFn:  () => ticketingApi.bestellungen(event.id),
    refetchInterval: 15_000,
  })

  const senden = useMutation({
    mutationFn: ({ id, email }: { id: string; email?: string }) => ticketingApi.bestellungSenden(id, email),
    onSuccess:  (r) => {
      setMeldung(r.erfolgreich ? { ok: true, text: 'E-Mail verschickt.' } : { ok: false, text: r.fehler ?? 'Versand fehlgeschlagen' })
      void qc.invalidateQueries({ queryKey: ['ticket-bestellungen', event.id] })
    },
    onError: (err) => setMeldung({ ok: false, text: fehlerText(err) }),
  })

  function nachsenden(id: string, email: string) {
    const ziel = window.prompt('Tickets und Beleg erneut senden an:', email)
    if (!ziel) return
    senden.mutate(ziel.trim() === email ? { id } : { id, email: ziel.trim() })
  }

  if (isLoading) return <p className="text-sm text-ink-muted">Lädt…</p>
  if (liste.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong py-10 text-center text-sm text-ink-muted">
        Noch keine Online-Bestellungen. Den Link zum Verkauf gibt es oben unter „Online-Verkauf“.
      </div>
    )
  }

  const bezahlt = liste.filter(b => b.status === 'bezahlt')
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        {bezahlt.length} bezahlt · {bezahlt.reduce((s, b) => s + b.anzahlTickets, 0)} Tickets ·{' '}
        {formatPreis(bezahlt.reduce((s, b) => s + b.summeCent, 0))}
      </p>
      {meldung && <p className={`text-sm ${meldung.ok ? 'text-green-700' : 'text-red-600'}`}>{meldung.text}</p>}
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="px-3 py-2">Zeit</th>
              <th className="px-3 py-2">Käufer</th>
              <th className="px-3 py-2">Tickets</th>
              <th className="px-3 py-2 text-right">Betrag</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">E-Mail</th>
            </tr>
          </thead>
          <tbody>
            {liste.map(b => (
              <tr key={b.id} className="border-b border-line align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-muted">{ZEIT.format(new Date(b.createdAt))}</td>
                <td className="px-3 py-2">
                  <p className="font-medium text-ink">{b.name}</p>
                  <p className="text-xs text-ink-muted">{b.email}</p>
                  {b.rechnungFirma && <p className="text-xs text-ink-muted">Rechnung: {b.rechnungFirma}</p>}
                </td>
                <td className="px-3 py-2 text-ink">
                  {b.positionen.map((p, i) => <p key={i} className="whitespace-nowrap">{p.menge} × {p.bezeichnung}</p>)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{b.summeCent === 0 ? 'kostenlos' : formatPreis(b.summeCent)}</td>
                <td className="px-3 py-2">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STIL[b.status]}`}>
                    {TICKET_BESTELLUNG_STATUS_LABELS[b.status]}
                  </span>
                  {b.belegNummer !== null && <p className="mt-1 text-xs text-ink-muted">Beleg Nr. {b.belegNummer}</p>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {b.status === 'bezahlt' && (
                    <>
                      {b.emailFehler
                        ? <p className="text-red-600" title={b.emailFehler}>⚠ {b.emailFehler}</p>
                        : b.emailGesendetAt ? <p className="text-green-700">✓ {ZEIT.format(new Date(b.emailGesendetAt))}</p> : <p className="text-ink-muted">—</p>}
                      <button type="button" className="mt-1 font-medium text-brand-600 hover:underline"
                        disabled={senden.isPending} onClick={() => nachsenden(b.id, b.email)}>
                        Erneut senden
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
