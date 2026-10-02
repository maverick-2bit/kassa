/**
 * kategorie-baum.ts — Untergruppen-Baum der Warengruppen (kategorien.parentId).
 *
 * Reiter der Kasse sind die Hauptgruppen; Untergruppen erscheinen als Kacheln
 * IN der Gruppe. Reine Funktionen, damit Kasse, Tisch, Konfiguration und
 * Verwaltung dieselbe Auslegung benutzen.
 */

import type { Kategorie } from '@kassa/shared'

type Knoten = Pick<Kategorie, 'id' | 'parentId'>

const nachReihenfolge = <T extends Pick<Kategorie, 'reihenfolge' | 'name'>>(a: T, b: T) =>
  a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name)

/** Eine Gruppe gilt als Hauptgruppe, wenn sie keinen (in `menge` vorhandenen) Elternteil hat. */
export function wurzelgruppen<T extends Kategorie>(menge: readonly T[]): T[] {
  const ids = new Set(menge.map(k => k.id))
  return menge.filter(k => !k.parentId || !ids.has(k.parentId)).sort(nachReihenfolge)
}

/** Direkte Untergruppen, in Kachel-Reihenfolge. */
export function untergruppenVon<T extends Kategorie>(menge: readonly T[], id: string): T[] {
  return menge.filter(k => k.parentId === id).sort(nachReihenfolge)
}

/** Alle Nachkommen (Kinder, Enkel …) ohne die Gruppe selbst. */
export function nachkommenIds(menge: readonly Knoten[], id: string): string[] {
  const kinder = new Map<string, string[]>()
  for (const k of menge) if (k.parentId) kinder.set(k.parentId, [...(kinder.get(k.parentId) ?? []), k.id])
  const ergebnis: string[] = []
  const besucht = new Set<string>([id])
  const stapel = [id]
  while (stapel.length > 0) {
    for (const kind of kinder.get(stapel.pop()!) ?? []) {
      if (besucht.has(kind)) continue
      besucht.add(kind)
      ergebnis.push(kind)
      stapel.push(kind)
    }
  }
  return ergebnis
}

/** Ahnenkette von der Hauptgruppe bis einschließlich `id` (nur Gruppen aus `menge`). */
export function pfadIds(menge: readonly Knoten[], id: string): string[] {
  const parentVon = new Map(menge.map(k => [k.id, k.parentId] as const))
  const pfad: string[] = []
  const besucht = new Set<string>()
  for (let cur: string | null | undefined = id; cur && parentVon.has(cur) && !besucht.has(cur); cur = parentVon.get(cur)) {
    besucht.add(cur)
    pfad.unshift(cur)
  }
  return pfad
}

/** ID der Hauptgruppe, unter der `id` hängt (id selbst, wenn sie Hauptgruppe ist). */
export function wurzelIdVon(menge: readonly Knoten[], id: string): string | null {
  return pfadIds(menge, id)[0] ?? null
}

/**
 * Sichtbarkeit je Kasse (kasse_kategorie_sichtbarkeit) listet beliebige Gruppen.
 * Erweitert um deren Nachkommen (Untergruppen einer sichtbaren Gruppe sind
 * mit sichtbar) und Vorfahren (sonst wäre die Untergruppe nicht erreichbar).
 * Leere/fehlende Liste = alle sichtbar → unverändert.
 */
export function erweitereSichtbarkeit(
  menge: readonly Knoten[],
  ids: readonly string[] | undefined,
): string[] | undefined {
  if (!ids || ids.length === 0) return ids ? [...ids] : undefined
  const ergebnis = new Set(ids)
  for (const id of ids) {
    for (const n of nachkommenIds(menge, id)) ergebnis.add(n)
    for (const v of pfadIds(menge, id)) ergebnis.add(v)
  }
  return [...ergebnis]
}

/** Baum in Anzeige-Reihenfolge (Tiefensuche) mit Einrückungstiefe — für Listen und Auswahlfelder. */
export function baumFlach<T extends Kategorie>(menge: readonly T[]): { kategorie: T; tiefe: number }[] {
  const ergebnis: { kategorie: T; tiefe: number }[] = []
  const besucht = new Set<string>()
  const besuche = (k: T, tiefe: number) => {
    if (besucht.has(k.id)) return
    besucht.add(k.id)
    ergebnis.push({ kategorie: k, tiefe })
    for (const kind of untergruppenVon(menge, k.id)) besuche(kind, tiefe + 1)
  }
  for (const w of wurzelgruppen(menge)) besuche(w, 0)
  return ergebnis
}
