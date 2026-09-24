/**
 * API der Einlass-App. Anmeldung = Geräte-Token aus dem Einrichtungs-QR
 * (Backoffice → Tickets → Einlass-Geräte), gespeichert auf diesem Gerät.
 */

import type {
  EinlassErgebnis,
  EinlassEvent,
  EinlassIch,
  EinlassOfflineListe,
  EinlassSyncAntwort,
  EinlassSyncInput,
  TicketEinlassStand,
} from '@kassa/shared'

import { loescheAlles } from './speicher'

const KEY_TOKEN = 'einlass:token'
const KEY_EVENT = 'einlass:eventId'

export const leseToken     = (): string | null => localStorage.getItem(KEY_TOKEN)
export const merkeToken    = (t: string): void => localStorage.setItem(KEY_TOKEN, t.trim())
export const leseEventId   = (): string | null => localStorage.getItem(KEY_EVENT)
export const merkeEventId  = (id: string | null): void => {
  if (id) localStorage.setItem(KEY_EVENT, id); else localStorage.removeItem(KEY_EVENT)
}
/**
 * Abmelden — von Hand oder weil das Gerät im Backoffice gesperrt wurde
 * (verlorenes Handy): dann müssen auch die Offline-Listen mit Namen und
 * Geburtsdaten vom Gerät. Nicht nachgereichte Scans ließen sich mit einem
 * gesperrten Gerät ohnehin nicht mehr übertragen.
 */
export function abmelden(): void {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_EVENT)
  localStorage.removeItem('einlass:ich')
  localStorage.removeItem('einlass:event')
  void loescheAlles().catch(() => { /* ohne IndexedDB gibt es nichts zu löschen */ })
}

/** Gerät gesperrt / Token ungültig — die App zeigt dann wieder die Einrichtung. */
export class NichtAngemeldet extends Error {}
/** Keine Verbindung zum Server — der Scan wurde NICHT geprüft. */
export class KeineVerbindung extends Error {}

async function anfrage<T>(methode: string, pfad: string, body?: unknown, zeitlimitMs = 8000): Promise<T> {
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
      signal: AbortSignal.timeout(zeitlimitMs),
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
  /** Kurzes Zeitlimit: hängt das Netz, entscheidet nach 3,5 s die Offline-Liste */
  scan:   (eventId: string, inhalt: string) =>
    anfrage<EinlassErgebnis>('POST', '/api/einlass/scan', { eventId, inhalt }, 3500),
  offlineListe: (eventId: string, seit?: string) =>
    anfrage<EinlassOfflineListe>('GET', `/api/einlass/events/${eventId}/offline-liste${seit ? `?seit=${encodeURIComponent(seit)}` : ''}`, undefined, 20_000),
  sync: (eventId: string, scans: EinlassSyncInput['scans']) =>
    anfrage<EinlassSyncAntwort>('POST', '/api/einlass/sync', { eventId, scans }, 20_000),
}

// ---------------------------------------------------------------------------
// Zwischenspeicher für den Offline-Start (App wird ohne Netz geöffnet)
// ---------------------------------------------------------------------------

const KEY_ICH   = 'einlass:ich'
const KEY_EVENT_DATEN = 'einlass:event'

function leseJson<T>(key: string): T | null {
  try { const roh = localStorage.getItem(key); return roh ? JSON.parse(roh) as T : null } catch { return null }
}
export const merkeIch   = (ich: EinlassIch): void => localStorage.setItem(KEY_ICH, JSON.stringify(ich))
export const leseIch    = (): EinlassIch | null => leseJson<EinlassIch>(KEY_ICH)
export const merkeEvent = (e: EinlassEvent | null): void => {
  if (e) localStorage.setItem(KEY_EVENT_DATEN, JSON.stringify(e)); else localStorage.removeItem(KEY_EVENT_DATEN)
}
export const leseEvent  = (): EinlassEvent | null => leseJson<EinlassEvent>(KEY_EVENT_DATEN)
