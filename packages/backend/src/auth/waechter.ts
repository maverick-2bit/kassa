/**
 * Kennzeichnung der Zugriffs-Wächter (authenticate, requireRolle, requireBerechtigung, requireBetreiber).
 *
 * Jeder Wächter ist eine ganz normale onRequest-Funktion; zusätzlich trägt er ein unsichtbares Merkmal, WAS er prüft.
 * Daran liest tests/route-schutz.test.ts die tatsächlich registrierten Routen aus: jede Route muss entweder ausdrücklich
 * öffentlich sein oder einen Wächter haben — und „nur angemeldet" ist eine bewusste, begründete Ausnahme. So fällt eine
 * neue Route ohne Rechteprüfung beim nächsten Testlauf auf, statt erst in einer Prüfung (Prüfbericht 2026-11, Befund 3).
 */

import type { Berechtigung, Rolle } from '@kassa/shared'

export type Waechter =
  | { art: 'angemeldet' }
  | { art: 'rolle'; rollen: readonly Rolle[] }
  | { art: 'berechtigung'; berechtigungen: readonly Berechtigung[] }
  | { art: 'betreiber' }
  /** Nur ein bestimmtes Geräte-Token (z. B. Einlass-Scanner) — kein Benutzer. */
  | { art: 'geraet'; typ: string }

const MERKMAL = Symbol.for('kassa.waechter')

/** Hängt das Merkmal an die Wächter-Funktion und gibt sie unverändert zurück. */
export function alsWaechter<F extends (...args: never[]) => unknown>(wacht: F, was: Waechter): F {
  Object.defineProperty(wacht, MERKMAL, { value: was, enumerable: false })
  return wacht
}

/** Alle Wächter, die an einer Route in `onRequest` hängen (Reihenfolge wie registriert). */
export function waechterVon(onRequest: unknown): Waechter[] {
  const hooks = Array.isArray(onRequest) ? onRequest : onRequest ? [onRequest] : []
  const gefunden: Waechter[] = []
  for (const hook of hooks) {
    const merkmal = (hook as { [MERKMAL]?: Waechter } | null)?.[MERKMAL]
    if (merkmal) gefunden.push(merkmal)
  }
  return gefunden
}
