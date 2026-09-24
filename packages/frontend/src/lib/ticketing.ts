/**
 * Hilfen fürs Ticketing-Backoffice.
 */

import type { TicketAnzeigeStatus, TicketEventStatus } from '@kassa/shared'

/** Port der Ticket-App im Docker-Betrieb (öffentliche Ticketseite). */
export const TICKET_APP_PORT = 8086
/** Port der Einlass-App (Scanner am Eingang) im Docker-Betrieb. */
export const EINLASS_APP_PORT = 8087

const zwei = (n: number) => String(n).padStart(2, '0')

/** ISO-Zeitpunkt → Wert für <input type="datetime-local"> (Ortszeit des Browsers). */
export function zuDatetimeLokal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}T${zwei(d.getHours())}:${zwei(d.getMinutes())}`
}

/** Wert aus <input type="datetime-local"> → ISO (mit Zeitzone), leer → null. */
export function vonDatetimeLokal(wert: string): string | null {
  if (!wert) return null
  const d = new Date(wert)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Lesbare Fehlermeldung aus einer ApiError. Validierungsfehler kommen vom
 * Server als JSON-Liste von Zod-Issues — die zeigen wir als Sätze, nicht als JSON.
 */
export function fehlerText(err: unknown): string {
  const nachricht = err instanceof Error ? err.message : String(err)
  if (nachricht.startsWith('[')) {
    try {
      const issues = JSON.parse(nachricht) as Array<{ message?: string }>
      const texte = issues.map(i => i.message).filter(Boolean)
      if (texte.length > 0) return texte.join(' · ')
    } catch { /* kein JSON — Originaltext */ }
  }
  return nachricht
}

export const EVENT_STATUS_STIL: Record<TicketEventStatus, string> = {
  entwurf:         'bg-panel-2 text-ink-muted border-line-strong',
  test:            'bg-amber-50 text-amber-800 border-amber-200',
  veroeffentlicht: 'bg-green-50 text-green-800 border-green-200',
  abgesagt:        'bg-red-50 text-red-700 border-red-200',
}

export const TICKET_STATUS_STIL: Record<TicketAnzeigeStatus, string> = {
  gueltig:    'bg-green-50 text-green-800',
  eingeloest: 'bg-panel-2 text-ink-muted',
  storniert:  'bg-red-50 text-red-700',
  abgesagt:   'bg-red-50 text-red-700',
}

const EVENT_DATUM = new Intl.DateTimeFormat('de-AT', {
  weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})
export const formatEventDatum = (iso: string) => EVENT_DATUM.format(new Date(iso))
