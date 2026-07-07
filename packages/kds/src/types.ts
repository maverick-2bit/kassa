/**
 * KDS-spezifische Typen (Frontend).
 * Gespiegelt vom Backend KDS-Service.
 */

export type KdsStation = 'kueche' | 'schank' | 'kalte_kueche' | 'dessert'

export const STATION_LABELS: Record<KdsStation, string> = {
  kueche:      'Küche',
  schank:      'Schank',
  kalte_kueche: 'Kalte Küche',
  dessert:     'Dessert',
}

export const STATION_FARBEN: Record<KdsStation, string> = {
  kueche:      '#ef4444', // rot
  schank:      '#3b82f6', // blau
  kalte_kueche: '#06b6d4', // cyan
  dessert:     '#a855f7', // lila
}

export interface KdsPosition {
  id:             string   // uuid, eindeutig pro Position
  bezeichnung:    string
  menge:          number
  erledigtMenge?: number   // bereits gesendete Teilmenge
  details?:       string
  erledigt:       boolean
}

export interface KdsBon {
  id:         string   // uuid
  bonNummer:  string
  station:    KdsStation
  tisch:      string
  bereich?:   string
  kellner:    string
  positionen: KdsPosition[]
  erstelltAt: string   // ISO
  /** SB-Terminal-Bestellung: 4-stellige Nummer + ID (Badge, Rechnungsdruck) */
  sbBestellNummer?: string
  sbBestellungId?:  string
}

// SSE-Ereignisse vom Backend
export type KdsSseEvent =
  | { typ: 'snapshot';        bons: KdsBon[] }
  | { typ: 'neuer_bon';       bon: KdsBon }
  | { typ: 'bon_erledigt';    bonId: string }
  | { typ: 'position_toggle'; bonId: string; positionId: string; erledigt: boolean; erledigtMenge?: number }
  | { typ: 'kellner_antwort'; text: string; kasseBezeichnung: string; zeit: string }
