/**
 * Terminal-API-Client — spricht die öffentlichen Endpunkte unter /api/terminal.
 * Typen lokal gespiegelt (kein Login, kein Token — das Kiosk-Gerät ist anonym).
 */

export interface TerminalKategorie {
  id:    string
  name:  string
  farbe: string
}

export interface TerminalArtikel {
  id:              string
  bezeichnung:     string
  preisBruttoCent: number
  kategorieId:     string | null
  bild:            string | null
}

export interface TerminalSortiment {
  kasse:      { id: string; bezeichnung: string | null; firmenname: string }
  kategorien: TerminalKategorie[]
  artikel:    TerminalArtikel[]
}

export type SbStatus = 'zahlung' | 'offen' | 'bereit' | 'abgeholt' | 'abgebrochen'

export interface BestellungStatus {
  id:            string
  status:        SbStatus
  summeCent:     number
  bestellNummer: number | null
  demoZahlung:   boolean
  zahlung:       { status: string; meldung?: string } | null
}

export class TerminalApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body    = JSON.stringify(body ?? {})
  }
  const res  = await fetch(path, init)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const fehler = (data as { fehler?: unknown })?.fehler
    throw new TerminalApiError(res.status, typeof fehler === 'string' ? fehler : `HTTP ${res.status}`)
  }
  return data as T
}

export const terminalApi = {
  sortiment: (kasseId: string) =>
    request<TerminalSortiment>('GET', `/api/terminal/sortiment?kasseId=${encodeURIComponent(kasseId)}`),

  bestellen: (kasseId: string, positionen: { artikelId: string; menge: number }[]) =>
    request<BestellungStatus>('POST', '/api/terminal/bestellung', { kasseId, positionen }),

  status: (id: string) =>
    request<BestellungStatus>('GET', `/api/terminal/bestellung/${id}`),

  bestaetigen: (id: string) =>
    request<BestellungStatus>('POST', `/api/terminal/bestellung/${id}/bestaetigen`),

  abbrechen: (id: string) =>
    request<BestellungStatus>('POST', `/api/terminal/bestellung/${id}/abbrechen`),
}

export function formatPreis(cent: number): string {
  return `€ ${(cent / 100).toFixed(2).replace('.', ',')}`
}

export function formatNummer(nummer: number | null): string {
  return String(nummer ?? 0).padStart(4, '0')
}
