/**
 * Raster-Platzierung einer Warengruppe (Asello-Darstellungsregel):
 *  1. zuerst die Untergruppen als Kacheln (Reihenfolge vom Aufrufer),
 *  2. danach die Artikel an ihrer `rasterPosition` (Slot 1..n, zeilenweise ab
 *     der Zelle NACH den Untergruppen),
 *  3. fehlende Slotnummern sind leere Felder,
 *  4. Artikel ohne (oder mit doppelter/ungültiger) Position kommen hinten dran,
 *     sortiert nach reihenfolge, dann Bezeichnung.
 * Ohne einen einzigen positionierten Artikel entstehen keine Leerfelder.
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

export function baueRaster<G, A extends RasterArtikel>(
  untergruppen: readonly G[],
  artikel: readonly A[],
): RasterZelle<G, A>[] {
  const zellen: RasterZelle<G, A>[] = untergruppen.map(gruppe => ({ typ: 'gruppe', gruppe }))

  const vergeben = new Map<number, A>()
  const ohnePosition: A[] = []
  // Bei doppeltem Slot gewinnt der erste nach reihenfolge/Bezeichnung
  const sortiert = [...artikel].sort(
    (a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung),
  )
  for (const a of sortiert) {
    const slot = a.rasterPosition
    if (slot != null && Number.isInteger(slot) && slot >= 1 && !vergeben.has(slot)) vergeben.set(slot, a)
    else ohnePosition.push(a)
  }

  let hoechster = 0
  for (const slot of vergeben.keys()) if (slot > hoechster) hoechster = slot
  for (let slot = 1; slot <= hoechster; slot++) {
    const a = vergeben.get(slot)
    zellen.push(a ? { typ: 'artikel', artikel: a } : { typ: 'leer' })
  }
  for (const a of ohnePosition) zellen.push({ typ: 'artikel', artikel: a })
  return zellen
}
