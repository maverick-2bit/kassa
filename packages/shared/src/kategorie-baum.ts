/**
 * kategorie-baum.ts — Untergruppen-Baum der Warengruppen (kategorien.parentId).
 *
 * Reiter der Kasse sind die Hauptgruppen; Untergruppen erscheinen als Kacheln
 * IN der Gruppe. Reine Funktionen für Kasse, Tisch, Konfiguration, Verwaltung,
 * Kellner-App und Server (Gast-/Terminal-Karte, Optionen-Import) — dieselbe
 * Auslegung überall.
 *
 * `reihenfolge` ist die Position unter GESCHWISTERN (je Elterngruppe 0..n-1),
 * nie ein globaler Index: Mehrere Gruppen können denselben Namen tragen
 * (z. B. „Alkoholfrei" unter Atriumbar, Kellner Getränke und Event-Paketen) und
 * sind nur über ihre Elterngruppe unterscheidbar — daher Baumreihenfolge und
 * Pfad-Anzeige.
 */

import type { Kategorie } from './schemas/kategorie.js'

export type KategorieKnoten = Pick<Kategorie, 'id' | 'parentId'>
export type KategorieBenannt = Pick<Kategorie, 'id' | 'parentId' | 'name'>
export type KategorieSortierbar = Pick<Kategorie, 'id' | 'parentId' | 'name' | 'reihenfolge'>

const nachReihenfolge = <T extends Pick<Kategorie, 'reihenfolge' | 'name'>>(a: T, b: T) =>
  a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name)

/** Eine Gruppe gilt als Hauptgruppe, wenn sie keinen (in `menge` vorhandenen) Elternteil hat. */
export function wurzelgruppen<T extends KategorieSortierbar>(menge: readonly T[]): T[] {
  const ids = new Set(menge.map(k => k.id))
  return menge.filter(k => !k.parentId || !ids.has(k.parentId)).sort(nachReihenfolge)
}

/** Direkte Untergruppen, in Kachel-Reihenfolge. */
export function untergruppenVon<T extends KategorieSortierbar>(menge: readonly T[], id: string): T[] {
  return menge.filter(k => k.parentId === id).sort(nachReihenfolge)
}

/**
 * Geschwister einer Gruppe INKLUSIVE ihr selbst, in Reihenfolge: dieselbe Elterngruppe —
 * bzw. alle Hauptgruppen, wenn die Gruppe keine (vorhandene) Elterngruppe hat.
 */
export function geschwisterVon<T extends KategorieSortierbar>(menge: readonly T[], id: string): T[] {
  const k = menge.find(x => x.id === id)
  if (!k) return []
  const ids = new Set(menge.map(x => x.id))
  const hatEltern = !!k.parentId && ids.has(k.parentId)
  return hatEltern ? untergruppenVon(menge, k.parentId!) : wurzelgruppen(menge)
}

/** Alle Nachkommen (Kinder, Enkel …) ohne die Gruppe selbst. */
export function nachkommenIds(menge: readonly KategorieKnoten[], id: string): string[] {
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
export function pfadIds(menge: readonly KategorieKnoten[], id: string): string[] {
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
export function wurzelIdVon(menge: readonly KategorieKnoten[], id: string): string | null {
  return pfadIds(menge, id)[0] ?? null
}

/**
 * Sichtbarkeit je Kasse (kasse_kategorie_sichtbarkeit) listet beliebige Gruppen.
 * Erweitert um deren Nachkommen (Untergruppen einer sichtbaren Gruppe sind
 * mit sichtbar) und Vorfahren (sonst wäre die Untergruppe nicht erreichbar).
 * Leere/fehlende Liste = alle sichtbar → unverändert.
 */
export function erweitereSichtbarkeit(
  menge: readonly KategorieKnoten[],
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
export function baumFlach<T extends KategorieSortierbar>(menge: readonly T[]): { kategorie: T; tiefe: number }[] {
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

// ---------------------------------------------------------------------------
// Namen und Pfade
// ---------------------------------------------------------------------------

/** Trenner im Anzeige-Pfad: „Atriumbar › Alkoholfrei". */
export const KATEGORIE_PFAD_TRENNER = ' › '

/**
 * Namen von der Hauptgruppe bis zur Gruppe selbst. Unbekannte ID → []. Zyklen
 * im Altbestand und fehlende Elterngruppen beenden die Kette (kein Absturz).
 */
export function kategoriePfadNamen(menge: readonly KategorieBenannt[], id: string): string[] {
  const nameVon = new Map(menge.map(k => [k.id, k.name] as const))
  return pfadIds(menge, id).map(i => nameVon.get(i) ?? '')
}

/** Voller Pfad „Atriumbar › Alkoholfrei"; eine Hauptgruppe liefert nur ihren Namen, eine unbekannte ID ''. */
export function kategoriePfad(menge: readonly KategorieBenannt[], id: string, trenner: string = KATEGORIE_PFAD_TRENNER): string {
  return kategoriePfadNamen(menge, id).join(trenner)
}

const normName = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')

/**
 * Anzeige-Namen für alle Gruppen aus `menge`: der Name, wenn er in `menge` EINDEUTIG ist
 * (ohne Groß-/Kleinschreibung und Mehrfach-Leerzeichen), sonst der volle Pfad. Wer eine
 * Teilmenge übergibt (z. B. nur aktive Gruppen), bekommt die Eindeutigkeit in dieser Teilmenge.
 * Liefert eine Funktion, damit lange Listen die Zählung nur einmal bezahlen; unbekannte,
 * leere oder null-IDs ergeben ''.
 */
export function kategorieAnzeigeNamen(menge: readonly KategorieBenannt[]): (id: string | null | undefined) => string {
  const anzahl = new Map<string, number>()
  for (const k of menge) anzahl.set(normName(k.name), (anzahl.get(normName(k.name)) ?? 0) + 1)
  const nameVon = new Map(menge.map(k => [k.id, k.name] as const))
  return (id) => {
    if (!id) return ''
    const name = nameVon.get(id)
    if (name === undefined) return ''
    return (anzahl.get(normName(name)) ?? 0) > 1 ? kategoriePfad(menge, id) : name
  }
}

/** Anzeige-Name einer einzelnen Gruppe: Name, wenn eindeutig, sonst voller Pfad. */
export function kategorieAnzeigeName(menge: readonly KategorieBenannt[], id: string | null | undefined): string {
  return kategorieAnzeigeNamen(menge)(id)
}

/**
 * Vergleichsform eines Gruppen-Pfads oder -Namens: Segmente an „/", „›" oder „>" getrennt,
 * je Segment getrimmt, Leerzeichen zusammengefasst, klein geschrieben; Ergebnis mit „/" verbunden.
 * So treffen „Atriumbar/Alkoholfrei", „Atriumbar › Alkoholfrei" und „atriumbar / alkoholfrei"
 * dieselbe Gruppe (Excel-Spalte „Warengruppe", Optionen-Import).
 */
export function normalisiereKategoriePfad(eingabe: string): string {
  return eingabe.split(/[/›>]/).map(normName).filter(s => s !== '').join('/')
}

/** Vergleichsform des vollen Pfads einer Gruppe (siehe normalisiereKategoriePfad). */
export function kategoriePfadNormalisiert(menge: readonly KategorieBenannt[], id: string): string {
  return normalisiereKategoriePfad(kategoriePfadNamen(menge, id).join('/'))
}

/** Ergebnis der Zuordnung einer eingetippten Warengruppe (Name oder Pfad) zu den vorhandenen Gruppen. */
export type KategorieAufloesung<T extends KategorieBenannt = KategorieBenannt> =
  | { art: 'gefunden';   kategorie: T }
  | { art: 'mehrdeutig'; kandidaten: T[] }
  | { art: 'unbekannt' }

/**
 * Ordnet eine eingetippte Warengruppe — Name ODER Pfad („Atriumbar/Alkoholfrei") — genau einer Gruppe zu.
 * Trifft der Text mehrere Gruppen (gleichnamige Gruppen unter verschiedenen Eltern), ist das
 * `mehrdeutig` — NIE wird still eine davon gewählt. Aktive Gruppen gehen vor: gibt es
 * aktive Treffer, zählen inaktive nicht mit.
 */
export function loeseKategorieAuf<T extends KategorieBenannt & { aktiv?: boolean }>(
  menge: readonly T[],
  eingabe: string,
): KategorieAufloesung<T> {
  const gesucht = normalisiereKategoriePfad(eingabe)
  if (gesucht === '') return { art: 'unbekannt' }
  const treffer = menge.filter(k =>
    normName(k.name) === normName(eingabe) || kategoriePfadNormalisiert(menge, k.id) === gesucht)
  const aktive = treffer.filter(k => k.aktiv !== false)
  const kandidaten = aktive.length > 0 ? aktive : treffer
  if (kandidaten.length === 0) return { art: 'unbekannt' }
  if (kandidaten.length === 1) return { art: 'gefunden', kategorie: kandidaten[0]! }
  return { art: 'mehrdeutig', kandidaten }
}

/**
 * Schreibweise einer Gruppe in Excel-Spalten und Auswahllisten, die sich per `loeseKategorieAuf`
 * wieder genau dieser Gruppe zuordnen lässt: der Name, wenn er in `menge` eindeutig ist,
 * sonst der volle Pfad mit „/" („Atriumbar/Alkoholfrei").
 */
export function kategorieSchluessel(menge: readonly KategorieBenannt[], id: string): string {
  const name = menge.find(k => k.id === id)?.name
  if (name === undefined) return ''
  return kategorieAnzeigeName(menge, id) === name ? name : kategoriePfad(menge, id, '/')
}

/** Bonier-Routing einer Warengruppe: KDS-Station und/oder Standard-Bonierdrucker. */
export interface KategorieRouting {
  station:         string | null
  bonierdruckerId: string | null
}

/**
 * Wirksames Routing je Warengruppe: Station und Bonierdrucker werden von der
 * Elterngruppe geerbt, solange die Untergruppe selbst keine eigene Angabe hat
 * (die nächstgelegene Gruppe nach oben gewinnt). Beides wird getrennt geerbt —
 * eine Untergruppe mit eigenem Drucker erbt trotzdem die Station der Hauptgruppe.
 * Zyklen und fehlende Eltern beenden die Kette (kein Absturz).
 */
export function wirksamesKategorieRouting(
  menge: readonly (KategorieKnoten & { station: string | null; bonierdruckerId: string | null })[],
): Map<string, KategorieRouting> {
  const nachId = new Map(menge.map(k => [k.id, k] as const))
  const ergebnis = new Map<string, KategorieRouting>()
  for (const k of menge) {
    let station: string | null = null
    let bonierdruckerId: string | null = null
    const besucht = new Set<string>()
    for (let cur: typeof k | undefined = k; cur && !besucht.has(cur.id); cur = cur.parentId ? nachId.get(cur.parentId) : undefined) {
      besucht.add(cur.id)
      station         ??= cur.station
      bonierdruckerId ??= cur.bonierdruckerId
      if (station !== null && bonierdruckerId !== null) break
    }
    ergebnis.set(k.id, { station, bonierdruckerId })
  }
  return ergebnis
}
