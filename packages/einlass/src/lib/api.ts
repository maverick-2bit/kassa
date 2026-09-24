/**
 * API der Einlass-App. Anmeldung = Geräte-Token aus dem Einrichtungs-QR
 * (Backoffice → Tickets → Einlass-Geräte), gespeichert auf diesem Gerät.
 */

import type {
  EinlassErgebnis,
  EinlassEvent,
  EinlassIch,
  TicketEinlassStand,
} from '@kassa/shared'

const KEY_TOKEN = 'einlass:token'
const KEY_EVENT = 'einlass:eventId'

export const leseToken     = (): string | null => localStorage.getItem(KEY_TOKEN)
export const merkeToken    = (t: string): void => localStorage.setItem(KEY_TOKEN, t.trim())
export const leseEventId   = (): string | null => localStorage.getItem(KEY_EVENT)
export const merkeEventId  = (id: string | null): void => {
  if (id) localStorage.setItem(KEY_EVENT, id); else localStorage.removeItem(KEY_EVENT)
}
export function abmelden(): void {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_EVENT)
}

/** Gerät gesperrt / Token ungültig — die App zeigt dann wieder die Einrichtung. */
export class NichtAngemeldet extends Error {}
/** Keine Verbindung zum Server — der Scan wurde NICHT geprüft. */
export class KeineVerbindung extends Error {}

async function anfrage<T>(methode: string, pfad: string, body?: unknown): Promise<T> {
  const token = leseToken()
  if (!token) throw new NichtAngemeldet('Kein Geräte-Token')
  let res: Response
  try {
    res = await fetch(pfad, {
      method: methode,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    throw new KeineVerbindung('Keine Verbindung zum Server')
  }
  if (res.status === 401) {
    abmelden()
    throw new NichtAngemeldet((await res.json().catch(() => null))?.fehler ?? 'Gerät nicht angemeldet')
  }
  const daten = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    const f = (daten as { fehler?: unknown } | null)?.fehler
    throw new Error(typeof f === 'string' ? f : `Fehler ${res.status}`)
  }
  return daten as T
}

export const einlassApi = {
  ich:    () => anfrage<EinlassIch>('GET', '/api/einlass/ich'),
  events: () => anfrage<EinlassEvent[]>('GET', '/api/einlass/events'),
  stand:  (eventId: string) => anfrage<TicketEinlassStand>('GET', `/api/einlass/events/${eventId}/stand`),
  scan:   (eventId: string, inhalt: string) => anfrage<EinlassErgebnis>('POST', '/api/einlass/scan', { eventId, inhalt }),
}
