/**
 * artikel-anordnung.ts — Zustand und Bedienung des Kachel-Editors „Artikel anordnen"
 * (POS-Konfiguration → Reiter Artikel).
 *
 * Eine Warengruppe ist ein Raster: erst die festen Untergruppen-Kacheln, danach die Artikel an ihren
 * Slots (Slot 1 = erste Zelle NACH den Untergruppen-Kacheln). Der Editor-Zustand kennt nur die Slots —
 * wie viele Spalten das Raster hat, entscheidet erst die Anzeige: ← → verschieben um einen Slot,
 * ↑ ↓ um eine Zeile (= `spalten` Slots).
 *
 * Alle Funktionen sind rein und liefern bei „nichts zu tun" dieselbe Referenz zurück:
 *  - Artikel auf eine freie Zelle → verschoben; auf eine belegte Zelle → die beiden tauschen
 *  - Artikel aus der Ablage (ausgeblendet / nicht platziert) lassen sich nur auf FREIE Zellen setzen
 *  - Slots liegen immer in 1..MAX_SLOT; leere Felder am Ende werden nicht gehalten
 *  - `entferneLuecken` verdichtet die Reihenfolge lückenlos (3er-Raster → 4er-Raster)
 */

import {
  KASSEN_LAYOUT_MAX_POSITION,
  type KasseArtikelLayoutEintrag,
  type StandardRasterEintrag,
} from '@kassa/shared'

/** Höchster Slot, den der Editor vergibt (= Grenze der Kassen-Anordnung). */
export const MAX_SLOT = KASSEN_LAYOUT_MAX_POSITION

export interface Anordnung {
  /** Index 0 = Slot 1: ID des Artikels oder null (leeres Feld); ohne leere Felder am Ende */
  readonly slots: readonly (string | null)[]
  /** Ausgeblendet / noch nicht platziert, in der Reihenfolge des Ausblendens */
  readonly ausgeblendet: readonly string[]
}

/** Aufgelöste Anordnung aus `loeseAnordnungAuf` (@kassa/shared) als Editor-Zustand. */
export function anordnungVon(aufgeloest: {
  slots: readonly ({ id: string } | null)[]
  ausgeblendet: readonly { id: string }[]
}): Anordnung {
  return {
    slots: kappe(aufgeloest.slots.map(a => a?.id ?? null)),
    ausgeblendet: aufgeloest.ausgeblendet.map(a => a.id),
  }
}

/** Entfernt leere Felder am Ende (neue Liste). */
function kappe(slots: readonly (string | null)[]): (string | null)[] {
  let ende = slots.length
  while (ende > 0 && slots[ende - 1] === null) ende--
  return slots.slice(0, ende)
}

/** 1-basierter Slot des Artikels; null, wenn er nicht platziert ist. */
export function slotVon(z: Anordnung, artikelId: string): number | null {
  const i = z.slots.indexOf(artikelId)
  return i < 0 ? null : i + 1
}

/** Wie viele Artikel stehen im Raster (ohne leere Felder). */
export function anzahlPlatziert(z: Anordnung): number {
  return z.slots.reduce((summe, s) => summe + (s === null ? 0 : 1), 0)
}

/** Gibt es leere Felder zwischen den Artikeln? */
export function hatLuecken(z: Anordnung): boolean {
  return z.slots.some(s => s === null)
}

/**
 * Setzt den Artikel auf den Slot `ziel` (Ziehen auf eine Zelle, ← → ↑ ↓):
 *  - freie Zelle → der Artikel zieht um, seine alte Zelle wird leer
 *  - belegte Zelle → die beiden Artikel tauschen die Plätze
 *  - Artikel aus der Ablage → nur auf eine freie Zelle
 * Außerhalb 1..MAX_SLOT, derselbe Platz oder unbekannter Artikel: unverändert (gleiche Referenz).
 */
export function setzeAufSlot(z: Anordnung, artikelId: string, ziel: number): Anordnung {
  if (!Number.isInteger(ziel) || ziel < 1 || ziel > MAX_SLOT) return z
  const von = z.slots.indexOf(artikelId)
  const zielIdx = ziel - 1
  if (von === zielIdx) return z

  const slots: (string | null)[] = [...z.slots]
  while (slots.length <= zielIdx) slots.push(null)
  const belegt = slots[zielIdx] ?? null

  if (von >= 0) {
    slots[von] = belegt
    slots[zielIdx] = artikelId
    return { slots: kappe(slots), ausgeblendet: z.ausgeblendet }
  }
  if (!z.ausgeblendet.includes(artikelId)) return z
  if (belegt !== null) return z
  slots[zielIdx] = artikelId
  return { slots: kappe(slots), ausgeblendet: z.ausgeblendet.filter(id => id !== artikelId) }
}

/** Verschiebt einen platzierten Artikel um `delta` Slots (±1 = Zelle, ±Spalten = Zeile). */
export function versetze(z: Anordnung, artikelId: string, delta: number): Anordnung {
  const slot = slotVon(z, artikelId)
  return slot === null || delta === 0 ? z : setzeAufSlot(z, artikelId, slot + delta)
}

/** Ob `versetze` etwas bewirken würde (für die Knöpfe: gesperrt am Rand). */
export function kannVersetzen(z: Anordnung, artikelId: string, delta: number): boolean {
  const slot = slotVon(z, artikelId)
  if (slot === null || delta === 0) return false
  const ziel = slot + delta
  return Number.isInteger(ziel) && ziel >= 1 && ziel <= MAX_SLOT
}

/** Nimmt einen platzierten Artikel aus dem Raster in die Ablage („ausgeblendet"); sein Platz bleibt als leeres Feld. */
export function blendeAus(z: Anordnung, artikelId: string): Anordnung {
  const von = z.slots.indexOf(artikelId)
  if (von < 0) return z
  const slots: (string | null)[] = [...z.slots]
  slots[von] = null
  return { slots: kappe(slots), ausgeblendet: [...z.ausgeblendet, artikelId] }
}

/** Setzt einen Artikel aus der Ablage in die erste freie Zelle (sonst hinten dran); am Rasterende (MAX_SLOT): unverändert. */
export function platziere(z: Anordnung, artikelId: string): Anordnung {
  if (!z.ausgeblendet.includes(artikelId)) return z
  const frei = z.slots.indexOf(null)
  return setzeAufSlot(z, artikelId, frei >= 0 ? frei + 1 : z.slots.length + 1)
}

/** Verdichtet die Reihenfolge lückenlos — Schnellweg vom 3er- zum 4er-Raster. Ohne Lücken: gleiche Referenz. */
export function entferneLuecken(z: Anordnung): Anordnung {
  if (!hatLuecken(z)) return z
  return { slots: z.slots.filter(s => s !== null), ausgeblendet: z.ausgeblendet }
}

/** Vergleichsschlüssel: gleiche Platzierung + gleiche Ablage (Reihenfolge der Ablage egal). */
export function anordnungSchluessel(z: Anordnung): string {
  return JSON.stringify([z.slots, [...z.ausgeblendet].sort()])
}

export function istGleich(a: Anordnung, b: Anordnung): boolean {
  return a === b || anordnungSchluessel(a) === anordnungSchluessel(b)
}

/**
 * Anzahl der anzuzeigenden Slot-Zellen: alles bis zum letzten Artikel (`slotsLaenge` = Länge von
 * `Anordnung.slots`), die Zeile auffüllen und MINDESTENS EINE komplett leere Zeile am Ende
 * (Ablageziel zum Anhängen). Höchstens MAX_SLOT. `untergruppen` = Zahl der festen Kacheln davor
 * (sie schieben den Zeilenumbruch, sind aber keine Slot-Zellen).
 */
export function anzahlSlotZellen(slotsLaenge: number, untergruppen: number, spalten: number): number {
  const zeilen = Math.ceil((untergruppen + slotsLaenge) / spalten) + 1
  return Math.min(MAX_SLOT, zeilen * spalten - untergruppen)
}

/** Position (Zeile, Spalte — beide 1-basiert) einer Zelle im Raster; `index` zählt ab der ersten Untergruppen-Kachel. */
export function zellPosition(index: number, spalten: number): { zeile: number; spalte: number } {
  return { zeile: Math.floor(index / spalten) + 1, spalte: (index % spalten) + 1 }
}

/** Zeilen für PUT /kassen/:kasseId/artikel-layouts/:kategorieId — platziert nach Slot, dann die Ablage. */
export function zuKassenEintraegen(z: Anordnung): KasseArtikelLayoutEintrag[] {
  const eintraege: KasseArtikelLayoutEintrag[] = []
  z.slots.forEach((id, i) => {
    if (id !== null) eintraege.push({ artikelId: id, position: i + 1, ausgeblendet: false })
  })
  for (const id of z.ausgeblendet) eintraege.push({ artikelId: id, position: null, ausgeblendet: true })
  return eintraege
}

/**
 * Zeilen der gespeicherten Anordnung zu Artikeln, die der Editor nicht kennt (z. B. deaktiviert):
 * sie bleiben beim Speichern erhalten, damit der Artikel nach dem Reaktivieren wieder an seinem
 * Platz steht — es sei denn, sein Slot wurde inzwischen für einen anderen Artikel gebraucht.
 */
export function unbekannteZeilenBehalten(
  gespeichert: readonly KasseArtikelLayoutEintrag[],
  bekannteArtikelIds: ReadonlySet<string>,
  neu: readonly KasseArtikelLayoutEintrag[],
): KasseArtikelLayoutEintrag[] {
  const belegt = new Set(neu.flatMap(e => (e.position === null ? [] : [e.position])))
  const behalten: KasseArtikelLayoutEintrag[] = []
  for (const e of gespeichert) {
    if (bekannteArtikelIds.has(e.artikelId)) continue
    if (e.position !== null) {
      if (belegt.has(e.position)) continue
      belegt.add(e.position)
    }
    behalten.push(e)
  }
  return behalten
}

/** Einträge für PUT /kategorien/:kategorieId/artikel-raster — Slot je platziertem Artikel; Ablage → null. */
export function zuStandardEintraegen(z: Anordnung): StandardRasterEintrag[] {
  const eintraege: StandardRasterEintrag[] = []
  z.slots.forEach((id, i) => {
    if (id !== null) eintraege.push({ artikelId: id, position: i + 1 })
  })
  for (const id of z.ausgeblendet) eintraege.push({ artikelId: id, position: null })
  return eintraege
}
