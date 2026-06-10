/**
 * KDS API-Client – spricht mit dem Backend unter /api/kds/...
 */

const BASE = '/api/kds'

function headers(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/** Alle aktiven Bons einer Station laden */
export async function fetchBons(station: string, token: string) {
  const res = await fetch(`${BASE}/bons?station=${station}`, {
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Fehler beim Laden: ${res.status}`)
  return res.json()
}

/** Bon als vollständig erledigt markieren */
export async function bonErledigt(bonId: string, token: string) {
  const res = await fetch(`${BASE}/bon/${bonId}/erledigt`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

/** Teilbon – ausgewählte Positionen als erledigt markieren */
export async function bonTeilbon(bonId: string, positionIds: string[], token: string) {
  const res = await fetch(`${BASE}/bon/${bonId}/teilbon`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ positionIds }),
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

export interface KdsKasse {
  id:          string
  kassenId:    string
  bezeichnung: string | null
}

/** Alle Kassen des Mandanten laden (für Chat-Targeting) */
export async function ladeKassen(token: string): Promise<KdsKasse[]> {
  const res = await fetch(`${BASE}/kassen`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

/** Nachricht an Kellner senden — kasseIds leer = Broadcast an alle */
export async function nachrichtSenden(
  text:     string,
  station:  string,
  token:    string,
  kasseIds: string[] = [],
): Promise<void> {
  const res = await fetch(`${BASE}/nachricht`, {
    method:  'POST',
    headers: headers(token),
    body:    JSON.stringify({ text, station, kasseIds }),
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
}

/** SSE-URL für eine Station */
export function kdsEventSourceUrl(station: string, token: string) {
  return `${BASE}/events?station=${station}&token=${encodeURIComponent(token)}`
}
