/**
 * uuid-Pfadparameter prüfen, bevor sie eine Datenbankabfrage erreichen.
 *
 * Ungeprüft läuft z. B. GET /api/kunden/kein-uuid bis in Postgres, das mit
 * 22P02 („invalid input syntax for type uuid") abbricht — der Client bekäme
 * 500 { fehler: 'Interner Serverfehler' } für einen reinen Eingabefehler.
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
