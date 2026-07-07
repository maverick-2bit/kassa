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
    // Fastify lehnt leere Bodies mit JSON-Content-Type ab (400)
    body: '{}',
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

/** Teilbon – Positionen mit Teilmenge senden */
export async function bonTeilbon(
  bonId:      string,
  posMengen:  { id: string; menge: number }[],
  token:      string,
) {
  const res = await fetch(`${BASE}/bon/${bonId}/teilbon`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ positionsMengen: posMengen }),
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

/** Archiv-Bons laden (alle Stationen oder gefiltert) */
export async function ladeArchiv(
  token:    string,
  station?: string,
  limit    = 50,
  offset   = 0,
): Promise<ArchivBon[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (station) params.set('station', station)
  const res = await fetch(`${BASE}/archiv?${params}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

/** Bon nachdrucken (an alle konfigurierten Bonierdrucker) */
export async function bonNachdrucken(
  bonId: string,
  token: string,
): Promise<{ gedruckt: number; fehler: number }> {
  const res = await fetch(`${BASE}/bon/${bonId}/nachdrucken`, {
    method: 'POST',
    headers: headers(token),
    // Fastify lehnt leere Bodies mit JSON-Content-Type ab (400)
    body: '{}',
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

export interface ArchivBon {
  id:         string
  bonNummer:  string
  station:    string
  tisch:      string
  bereich?:   string
  kellner:    string
  positionen: Array<{
    id:             string
    bezeichnung:    string
    menge:          number
    erledigtMenge?: number
    details?:       string
    erledigt:       boolean
  }>
  status:     string
  erstelltAt: string
}

// ---------------------------------------------------------------------------
// SB-Terminal-Bestellungen (Abhol-Leiste + Rechnungsdruck)
// ---------------------------------------------------------------------------

export interface SbBestellungEintrag {
  id:            string
  bestellNummer: number
  status:        string
  summeCent:     number
  positionen:    { bezeichnung: string; menge: number }[]
  erstelltAt:    string
  bereitAt:      string | null
}

/** Heutige SB-Bestellungen (für die Abhol-Leiste: Status 'bereit' filtern) */
export async function sbBestellungen(token: string): Promise<SbBestellungEintrag[]> {
  const res = await fetch('/api/sb-bestellungen', { headers: headers(token) })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}

/** SB-Bestellung als abgeholt quittieren — verschwindet vom Abholmonitor */
export async function sbAbgeholt(id: string, token: string): Promise<void> {
  const res = await fetch(`/api/sb-bestellungen/${id}/abgeholt`, {
    method: 'POST',
    headers: headers(token),
    body: '{}',
  })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
}

export interface SbRechnungAntwort {
  beleg:         import('@kassa/shared').BelegResponse
  mandant:       { firmenname: string; uid: string }
  bestellNummer: number | null
}

/** Beleg + Mandant-Stammdaten für den Rechnungsdruck zu einer SB-Bestellung */
export async function sbRechnung(id: string, token: string): Promise<SbRechnungAntwort> {
  const res = await fetch(`${BASE}/sb/${id}/rechnung`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Fehler: ${res.status}`)
  return res.json()
}
