/**
 * Abholmonitor-Event-Bus.
 * Kanal: abholung:{mandantId}
 *
 * Das Backend pusht SB-Bestellungs-Statuswechsel hierher; der öffentliche
 * Abholmonitor empfängt sie via SSE (/sse/abholung?kasseId=…).
 * Öffentlicher Kanal → Events enthalten NUR Nummern + Zeiten, nie Positionen.
 */

import { EventEmitter } from 'node:events'
import type { AbholungEvent } from '@kassa/shared'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function emitAbholungEvent(mandantId: string, event: AbholungEvent): void {
  bus.emit(`abholung:${mandantId}`, event)
}

export function onAbholungEvent(
  mandantId: string,
  cb:        (event: AbholungEvent) => void,
): () => void {
  const key = `abholung:${mandantId}`
  bus.on(key, cb)
  return () => bus.off(key, cb)
}
