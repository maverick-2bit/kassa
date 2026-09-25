/**
 * uuid-Pfad- und Query-Parameter prüfen, bevor sie eine Datenbankabfrage erreichen.
 *
 * Ungeprüft läuft z. B. GET /api/kunden/kein-uuid oder GET /api/gutscheine?kundeId=kein-uuid
 * bis in Postgres, das mit 22P02 („invalid input syntax for type uuid") abbricht —
 * der Client bekäme 500 { fehler: 'Interner Serverfehler' } für einen reinen Eingabefehler.
 *
 * Ungültig → UngueltigeIdError. Den beantwortet der globale Fehler-Handler wie
 * jeden Fachfehler mit httpStatus: 400 { fehler: 'Ungültige ID' } — dieselbe
 * Antwort wie bei den Routen mit eigenem IdParam-Schema (artikel.route.ts).
 * Deshalb am Anfang des Handlers aufrufen, nicht in einem try-Block, dessen
 * catch alle Fehler in eine eigene Antwort verwandelt.
 */

import { z } from 'zod'

const Uuid = z.string().uuid()

export class UngueltigeIdError extends Error {
  readonly httpStatus = 400
  constructor() {
    super('Ungültige ID')
    this.name = 'UngueltigeIdError'
  }
}

/** uuid-Pfadparameter `name` (Standard: `:id`) aus request.params — oder UngueltigeIdError. */
export function uuidParam(params: unknown, name = 'id'): string {
  const wert = Uuid.safeParse((params as Record<string, unknown> | undefined)?.[name])
  if (!wert.success) throw new UngueltigeIdError()
  return wert.data
}

/**
 * Optionaler uuid-Query-Parameter `name` aus request.query: fehlt oder leer → undefined
 * (wie bisher: kein Filter), sonst die uuid — oder UngueltigeIdError, auch wenn der
 * Parameter mehrfach kommt (?kundeId=…&kundeId=… liefert ein Array).
 */
export function uuidQuery(query: unknown, name: string): string | undefined {
  const roh = (query as Record<string, unknown> | undefined)?.[name]
  if (roh === undefined || roh === '') return undefined
  const wert = Uuid.safeParse(roh)
  if (!wert.success) throw new UngueltigeIdError()
  return wert.data
}
