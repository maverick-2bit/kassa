/**
 * KDS-spezifischer Event-Bus.
 * Kanal: kds:{mandantId}:{station}
 *
 * Wird getrennt vom KasseEvent-Bus betrieben, damit KDS-Displays
 * nur ihre eigene Station empfangen.
 */

import { EventEmitter } from 'node:events'

export type KdsSseEvent =
  | { typ: 'snapshot';        bons: KdsBonDto[] }
  | { typ: 'neuer_bon';       bon: KdsBonDto }
  | { typ: 'bon_erledigt';    bonId: string }
  | { typ: 'position_toggle'; bonId: string; positionId: string; erledigt: boolean; erledigtMenge?: number }
  | { typ: 'kellner_antwort'; text: string; kasseBezeichnung: string; zeit: string }

export interface KdsBonDto {
  id:         string
  bonNummer:  string
  station:    string
  tisch:      string
  bereich?:   string
  kellner:    string
  positionen: KdsPositionDto[]
  erstelltAt: string
  /** 4-stellige SB-Bestellnummer (nur bei Terminal-Bestellungen) */
  sbBestellNummer?: string
  /** SB-Bestellungs-ID (für Rechnungsdruck + Abholen am KDS) */
  sbBestellungId?: string
}

export interface KdsPositionDto {
  id:             string
  bezeichnung:    string
  menge:          number
  erledigtMenge?: number
  details?:       string
  erledigt:       boolean
}

const bus = new EventEmitter()
bus.setMaxListeners(500)

function kanal(mandantId: string, station: string) {
  return `kds:${mandantId}:${station}`
}

export function emitKdsEvent(mandantId: string, station: string, event: KdsSseEvent): void {
  bus.emit(kanal(mandantId, station), event)
}

export function onKdsEvent(
  mandantId: string,
  station:   string,
  cb:        (event: KdsSseEvent) => void,
): () => void {
  const key = kanal(mandantId, station)
  bus.on(key, cb)
  return () => bus.off(key, cb)
}
