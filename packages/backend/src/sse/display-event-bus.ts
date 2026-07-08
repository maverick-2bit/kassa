/**
 * Kundendisplay-Event-Bus.
 * Kanal: display:{kasseId}
 *
 * Das Kassafrontend pusht den aktuellen Warenkorb hierher;
 * das Kundendisplay empfängt ihn via SSE.
 */

import { EventEmitter } from 'node:events'

export interface DisplayPosition {
  bezeichnung: string
  menge:       number
  preisCent:   number
}

export type DisplayEvent =
  | { typ: 'warenkorb';     positionen: DisplayPosition[]; summeCent: number }
  | { typ: 'beleg_erstellt'; belegNummer: number; summeCent: number; belegId?: string; belegUrl?: string }
  | { typ: 'leer' }

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function emitDisplayEvent(kasseId: string, event: DisplayEvent): void {
  bus.emit(`display:${kasseId}`, event)
}

export function onDisplayEvent(
  kasseId: string,
  cb:      (event: DisplayEvent) => void,
): () => void {
  const key = `display:${kasseId}`
  bus.on(key, cb)
  return () => bus.off(key, cb)
}
