/**
 * kategorie-reihenfolge.ts — Reihenfolge der Warengruppen UNTER GESCHWISTERN.
 *
 * `kategorien.reihenfolge` ist die Position innerhalb der Elterngruppe (0..n-1 je Elterngruppe,
 * Hauptgruppen untereinander) — NIE ein globaler Index über die ganze Liste. Der Asello-Import legt
 * die Gruppen so an; schriebe „Reihenfolge speichern" die Positionen der flachen Anzeigeliste,
 * wäre die Reihenfolge der Untergruppen zerstört (Unterschiede zwischen den drei „Alkoholfrei"-Gruppen
 * gingen verloren, Geschwister verschiedener Eltern vermischten sich).
 *
 * Alles hier arbeitet deshalb nur INNERHALB einer Geschwistermenge und liefert beim Speichern
 * ausschließlich die Einträge der veränderten Geschwistermengen.
 */

import { geschwisterVon, wurzelgruppen } from './kategorie-baum'
import type { Gruppe } from './sichtbarkeit'

/** Schlüssel der Geschwistermenge: ID der Elterngruppe, '' für die Hauptgruppen (auch bei fehlender Elterngruppe). */
export function elternSchluessel(menge: readonly Gruppe[], id: string): string {
  const k = menge.find(x => x.id === id)
  if (!k || !k.parentId) return ''
  return menge.some(x => x.id === k.parentId) ? k.parentId : ''
}

/** IDs der Geschwister (inkl. der Gruppe selbst) in der aktuellen Reihenfolge. */
export function geschwisterIds(menge: readonly Gruppe[], id: string): string[] {
  return geschwisterVon(menge, id).map(k => k.id)
}

/** Setzt `reihenfolge` der genannten Geschwister auf 0..n-1 in der gegebenen Reihenfolge; alle anderen bleiben unverändert. */
function setzeReihenfolge<T extends Gruppe>(menge: readonly T[], reihenfolgeIds: readonly string[]): T[] {
  const position = new Map(reihenfolgeIds.map((id, i) => [id, i] as const))
  return menge.map(k => (position.has(k.id) ? { ...k, reihenfolge: position.get(k.id)! } : k))
}

/**
 * Verschiebt eine Gruppe um `delta` Plätze unter ihren Geschwistern (↑/↓: −1 / +1).
 * Am Rand oder bei unbekannter ID: unverändert (gleiche Referenz).
 */
export function verschiebeUnterGeschwistern<T extends Gruppe>(menge: readonly T[], id: string, delta: number): readonly T[] {
  const ids = geschwisterIds(menge, id)
  const von = ids.indexOf(id)
  const nach = von + delta
  if (von < 0 || nach < 0 || nach >= ids.length || delta === 0) return menge
  const neu = [...ids]
  neu.splice(von, 1)
  neu.splice(nach, 0, id)
  return setzeReihenfolge(menge, neu)
}

/**
 * Drag & Drop: `aktivId` an die Stelle von `zielId` — nur, wenn beide Geschwister sind
 * (gleiche Elterngruppe); sonst unverändert (gleiche Referenz).
 */
export function ziehUnterGeschwistern<T extends Gruppe>(menge: readonly T[], aktivId: string, zielId: string): readonly T[] {
  if (aktivId === zielId) return menge
  if (!menge.some(k => k.id === aktivId) || !menge.some(k => k.id === zielId)) return menge
  if (elternSchluessel(menge, aktivId) !== elternSchluessel(menge, zielId)) return menge
  const ids = geschwisterIds(menge, aktivId)
  const von = ids.indexOf(aktivId)
  const nach = ids.indexOf(zielId)
  if (von < 0 || nach < 0) return menge
  const neu = [...ids]
  neu.splice(von, 1)
  neu.splice(nach, 0, aktivId)
  return setzeReihenfolge(menge, neu)
}

/**
 * Einträge für PATCH /kategorien/reihenfolge: für jede veränderte Geschwistermenge die Position
 * (0..n-1) ALLER ihrer Mitglieder in der aktuellen Reihenfolge — sonst nichts.
 */
export function reihenfolgeEintraege(
  menge: readonly Gruppe[],
  geaenderteEltern: ReadonlySet<string>,
): { id: string; reihenfolge: number }[] {
  const eintraege: { id: string; reihenfolge: number }[] = []
  for (const schluessel of geaenderteEltern) {
    const geschwister = schluessel === ''
      ? wurzelgruppen(menge)
      : menge.filter(k => k.parentId === schluessel).sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
    geschwister.forEach((k, i) => eintraege.push({ id: k.id, reihenfolge: i }))
  }
  return eintraege
}
