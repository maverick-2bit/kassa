import { EventEmitter } from 'node:events'
import type { KasseEvent } from '@kassa/shared'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function emitKasseEvent(mandantId: string, event: KasseEvent): void {
  bus.emit(`mandant:${mandantId}`, event)
}

export function onKasseEvent(
  mandantId: string,
  cb: (event: KasseEvent) => void,
): () => void {
  bus.on(`mandant:${mandantId}`, cb)
  return () => bus.off(`mandant:${mandantId}`, cb)
}
