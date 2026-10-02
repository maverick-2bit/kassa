/**
 * Raster-Platzierung einer Warengruppe (Asello-Darstellungsregel):
 *  1. zuerst die Untergruppen als Kacheln (Reihenfolge vom Aufrufer),
 *  2. danach die Artikel an ihrer `rasterPosition` (Slot 1..n, zeilenweise ab
 *     der Zelle NACH den Untergruppen),
 *  3. fehlende Slotnummern sind leere Felder,
 *  4. Artikel ohne (oder mit doppelter/ungültiger) Position kommen hinten dran,
 *     sortiert nach reihenfolge, dann Bezeichnung.
 * Ohne einen einzigen positionierten Artikel entstehen keine Leerfelder.
 *
 * Das ist das STANDARD-Layout (Artikelstamm, gilt für alle Kassen). Zusätzlich kann
 * jede Kasse je Warengruppe eine EIGENE Anordnung haben (Tabelle kasse_artikel_layout,
 * z. B. weil sie 4 statt 3 Spalten hat): `baueKassenRaster` / `loeseAnordnungAuf`.
 *
 * Semantik der Kassen-Anordnung für (Kasse, Warengruppe):
 *  - Keine (gültige) Zeile → Standard-Layout, unverändert.
 *  - Mindestens eine gültige Zeile → die Kassen-Anordnung gilt:
 *      · platzierte Artikel stehen an ihrem Slot (Slot 1 = erste Zelle nach den Untergruppen-Kacheln),
 *      · fehlende Slotnummern sind leere Felder,
 *      · als `ausgeblendet` markierte Artikel erscheinen an dieser Kasse in dieser Warengruppe nicht,
 *      · Artikel OHNE Zeile (z. B. später neu angelegt) werden hinten angehängt, in
 *        Standard-Reihenfolge (reihenfolge, dann Bezeichnung) — nie verloren,
 *      · Zeilen zu Artikeln, die nicht (mehr) in dieser Warengruppe liegen, zählen nicht
 *        (Artikel in eine andere Gruppe verschoben, deaktiviert, gelöscht).
 *  - Robust gegen Altbestand: doppelte oder ungültige Positionen (<1, nicht ganzzahlig, über
 *    RASTER_MAX_SLOT, fehlend bei nicht ausgeblendetem Artikel) hängen den Artikel hinten an
 *    statt ihn zu verlieren; bei doppelter Position gewinnt der erste in Standard-Reihenfolge.
 */

export type RasterZelle<G, A> =
  | { typ: 'gruppe';  gruppe: G }
  | { typ: 'artikel'; artikel: A }
  | { typ: 'leer' }

export interface RasterArtikel {
  bezeichnung:    string
  reihenfolge:    number
  rasterPosition: number | null | undefined
}

/** Artikel mit ID — Voraussetzung für die Kassen-Anordnung (Zeilen verweisen per ID). */
export interface RasterArtikelMitId extends RasterArtikel {
  id: string
}

/**
 * Höchster Slot, der noch als gültig gilt. Schützt die Schleife über die Slots vor absurden
 * Werten aus dem Altbestand (z. B. 2 000 000 000 würde sonst Millionen Leerfelder erzeugen);
 * größere Werte behandelt die Platzierung wie „keine Position" (Artikel kommt hinten dran).
 * Die API des Artikelstamms erlaubt bis 999, die der Kassen-Anordnung bis KASSEN_LAYOUT_MAX_POSITION.
 */
export const RASTER_MAX_SLOT = 999

/** Eine Zeile der Kassen-Anordnung einer Warengruppe (artikelId + Slot bzw. ausgeblendet). */
export interface KassenAnordnungEintrag {
  artikelId:    string
  /** Slot 1..n im Raster der Warengruppe (nach den Untergruppen-Kacheln); null nur bei ausgeblendet */
  position:     number | null
  ausgeblendet: boolean
}

/** Aufgelöste Anordnung einer Warengruppe: wer steht in welchem Slot, wer ist ausgeblendet. */
export interface RasterAnordnung<A> {
  /** Artikel je Slot — Index 0 = Slot 1, null = leeres Feld; die Artikel ohne Platz hängen hinten dran */
  slots:        (A | null)[]
  /** An dieser Kasse in dieser Warengruppe ausgeblendet (in Standard-Reihenfolge) */
  ausgeblendet: A[]
  /** true = eine eigene Kassen-Anordnung wirkt, false = Standard-Layout */
  eigene:       boolean
}

interface Vorgabe {
  slot:         number | null | undefined
  ausgeblendet: boolean
}

function istGueltigerSlot(slot: number | null | undefined): slot is number {
  return slot != null && Number.isInteger(slot) && slot >= 1 && slot <= RASTER_MAX_SLOT
}

const standardReihenfolge = <A extends RasterArtikel>(a: A, b: A): number =>
  a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung)

/**
 * Kern der Platzierung für Standard- UND Kassen-Layout: `vorgabe` liefert je Artikel Slot und
 * Ausblenden — `undefined` heißt „keine Vorgabe" (kommt hinten dran).
 */
function ordne<A extends RasterArtikel>(
  artikel: readonly A[],
  vorgabe: (a: A) => Vorgabe | undefined,
): { slots: (A | null)[]; ausgeblendet: A[] } {
  const vergeben = new Map<number, A>()
  const angehaengt: A[] = []
  const ausgeblendet: A[] = []
  // Bei doppeltem Slot gewinnt der erste nach reihenfolge/Bezeichnung
  const sortiert = [...artikel].sort(standardReihenfolge)
  for (const a of sortiert) {
    const v = vorgabe(a)
    if (v?.ausgeblendet) { ausgeblendet.push(a); continue }
    const slot = v?.slot
    if (istGueltigerSlot(slot) && !vergeben.has(slot)) vergeben.set(slot, a)
    else angehaengt.push(a)
  }

  let hoechster = 0
  for (const slot of vergeben.keys()) if (slot > hoechster) hoechster = slot
  const slots: (A | null)[] = []
  for (let slot = 1; slot <= hoechster; slot++) slots.push(vergeben.get(slot) ?? null)
  for (const a of angehaengt) slots.push(a)
  return { slots, ausgeblendet }
}

const alsZellen = <G, A>(untergruppen: readonly G[], slots: readonly (A | null)[]): RasterZelle<G, A>[] => [
  ...untergruppen.map((gruppe): RasterZelle<G, A> => ({ typ: 'gruppe', gruppe })),
  ...slots.map((a): RasterZelle<G, A> => (a ? { typ: 'artikel', artikel: a } : { typ: 'leer' })),
]

/** STANDARD-Layout: Untergruppen-Kacheln, dann die Artikel an ihrer `rasterPosition`. */
export function baueRaster<G, A extends RasterArtikel>(
  untergruppen: readonly G[],
  artikel: readonly A[],
): RasterZelle<G, A>[] {
  const { slots } = ordne(artikel, a => ({ slot: a.rasterPosition, ausgeblendet: false }))
  return alsZellen(untergruppen, slots)
}

/**
 * Effektive Anordnung der `artikel` EINER Warengruppe an einer Kasse: Kassen-Anordnung aus
 * `eintraege` (Zeilen dieser Kasse + Warengruppe), sonst Standard — Regeln siehe Kopfkommentar.
 * `artikel` sind die Artikel, die die Kasse in dieser Gruppe überhaupt zeigen darf
 * (aktiv, verkäuflich); Zeilen zu anderen Artikeln werden ignoriert.
 */
export function loeseAnordnungAuf<A extends RasterArtikelMitId>(
  artikel: readonly A[],
  eintraege?: readonly KassenAnordnungEintrag[] | null,
): RasterAnordnung<A> {
  const ids = new Set(artikel.map(a => a.id))
  const zeileVon = new Map<string, KassenAnordnungEintrag>()
  for (const e of eintraege ?? []) {
    if (ids.has(e.artikelId) && !zeileVon.has(e.artikelId)) zeileVon.set(e.artikelId, e)
  }
  if (zeileVon.size === 0) {
    const { slots, ausgeblendet } = ordne(artikel, a => ({ slot: a.rasterPosition, ausgeblendet: false }))
    return { slots, ausgeblendet, eigene: false }
  }
  const { slots, ausgeblendet } = ordne(artikel, a => {
    const z = zeileVon.get(a.id)
    return z ? { slot: z.position, ausgeblendet: z.ausgeblendet } : undefined
  })
  return { slots, ausgeblendet, eigene: true }
}

/**
 * Raster einer Warengruppe an einer Kasse: Untergruppen-Kacheln vorn, dann die Artikel nach der
 * Kassen-Anordnung (`eintraege`) — ohne Anordnung exakt wie `baueRaster` (Standard).
 */
export function baueKassenRaster<G, A extends RasterArtikelMitId>(
  untergruppen: readonly G[],
  artikel: readonly A[],
  eintraege?: readonly KassenAnordnungEintrag[] | null,
): RasterZelle<G, A>[] {
  return alsZellen(untergruppen, loeseAnordnungAuf(artikel, eintraege).slots)
}

/**
 * IDs der Artikel, die eine Kasse in ihrer Warengruppe ausblendet (Kassen-Anordnung `ausgeblendet`).
 * Eine Zeile zählt nur, wenn der Artikel auch in der Warengruppe der Zeile liegt (veraltete Zeilen nach
 * einem Gruppenwechsel nicht). Für Zähler und Reiter-Auswahl der Oberflächen; das Raster selbst blendet
 * über `loeseAnordnungAuf` aus.
 */
export function ausgeblendeteArtikelIds(
  artikel: readonly { id: string; kategorieId: string | null }[],
  layouts: readonly { kategorieId: string; eintraege: readonly KassenAnordnungEintrag[] }[] | null | undefined,
): Set<string> {
  const ausgeblendet = new Set<string>()
  if (!layouts || layouts.length === 0) return ausgeblendet
  const gruppeVon = new Map(artikel.map(a => [a.id, a.kategorieId] as const))
  for (const l of layouts) {
    for (const e of l.eintraege) {
      if (e.ausgeblendet && gruppeVon.get(e.artikelId) === l.kategorieId) ausgeblendet.add(e.artikelId)
    }
  }
  return ausgeblendet
}

/**
 * Kompakte Artikelliste einer Warengruppe ohne Leerfelder (Kellner-App: die Reiter dort sind Listen ohne
 * Untergruppen-Kacheln). Mit eigener Kassen-Anordnung deren Reihenfolge (ausgeblendete Artikel entfallen,
 * Neulinge hinten); ohne sie wie bisher nach `reihenfolge` — das Standard-Layout bleibt hier unverändert.
 */
export function kompakteArtikelListe<A extends RasterArtikelMitId>(
  artikel: readonly A[],
  eintraege?: readonly KassenAnordnungEintrag[] | null,
): A[] {
  const anordnung = loeseAnordnungAuf(artikel, eintraege)
  if (anordnung.eigene) return anordnung.slots.filter((a): a is A => a !== null)
  return [...artikel].sort((a, b) => a.reihenfolge - b.reihenfolge)
}
