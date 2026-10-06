import { z } from 'zod'

// ---------------------------------------------------------------------------
// Artikel-Anordnung je Kasse (Kachel-Raster einer Warengruppe)
//
// Jede Kasse kann je Warengruppe eine EIGENE Anordnung der Artikel haben (Tabelle
// kasse_artikel_layout) — z. B. weil sie 4 statt der 3 Spalten des Import-Layouts hat.
// Ohne Anordnung gilt das Standard-Layout (artikel.raster_position, siehe raster.ts).
// ---------------------------------------------------------------------------

/** Höchster Slot einer Kassen-Anordnung (bei 6 Spalten rund 83 Zeilen). */
export const KASSEN_LAYOUT_MAX_POSITION = 500

/** Höchste Zahl Einträge je Warengruppe (platziert + ausgeblendet). */
export const KASSEN_LAYOUT_MAX_EINTRAEGE = 2000

/** Höchster Slot des Standard-Layouts (artikel.raster_position, wie ArtikelInput/Layout-Import). */
export const STANDARD_RASTER_MAX_POSITION = 999

/** Jeder Artikel höchstens einmal, jede Position höchstens einmal — Fehler je Eintrag unter ['eintraege', i, …]. */
function pruefeEindeutig(
  eintraege: readonly { artikelId: string; position: number | null }[],
  ctx: z.RefinementCtx,
): void {
  const artikel = new Set<string>()
  const positionen = new Set<number>()
  eintraege.forEach((e, i) => {
    if (artikel.has(e.artikelId)) {
      ctx.addIssue({ code: 'custom', path: ['eintraege', i, 'artikelId'], message: 'Artikel kommt mehrfach vor' })
    }
    artikel.add(e.artikelId)
    if (e.position !== null) {
      if (positionen.has(e.position)) {
        ctx.addIssue({ code: 'custom', path: ['eintraege', i, 'position'], message: `Position ${e.position} ist mehrfach vergeben` })
      }
      positionen.add(e.position)
    }
  })
}

/**
 * Ein Artikel in der Anordnung einer Warengruppe: platziert (position = Slot 1..n im Raster,
 * gezählt NACH den Untergruppen-Kacheln) oder an dieser Kasse ausgeblendet (position null).
 */
export const KasseArtikelLayoutEintragSchema = z.object({
  artikelId:    z.string().uuid(),
  position:     z.number().int().min(1).max(KASSEN_LAYOUT_MAX_POSITION).nullable(),
  ausgeblendet: z.boolean(),
}).superRefine((e, ctx) => {
  if (e.ausgeblendet && e.position !== null) {
    ctx.addIssue({ code: 'custom', path: ['position'], message: 'Ausgeblendete Artikel haben keine Position' })
  }
  if (!e.ausgeblendet && e.position === null) {
    ctx.addIssue({ code: 'custom', path: ['position'], message: 'Platzierte Artikel brauchen eine Position' })
  }
})
export type KasseArtikelLayoutEintrag = z.infer<typeof KasseArtikelLayoutEintragSchema>

/** Anordnung einer Warengruppe an einer Kasse (ein Element der Antwort von GET /kassen/:kasseId/artikel-layouts). */
export const KasseArtikelLayoutSchema = z.object({
  kategorieId: z.string().uuid(),
  eintraege:   z.array(KasseArtikelLayoutEintragSchema),
})
export type KasseArtikelLayout = z.infer<typeof KasseArtikelLayoutSchema>

/**
 * PUT /kassen/:kasseId/artikel-layouts/:kategorieId — ersetzt die Anordnung der Warengruppe
 * komplett. Jeder Artikel höchstens einmal, jede Position höchstens einmal.
 */
export const KasseArtikelLayoutUpdateSchema = z.object({
  eintraege: z.array(KasseArtikelLayoutEintragSchema).max(KASSEN_LAYOUT_MAX_EINTRAEGE),
}).superRefine((v, ctx) => pruefeEindeutig(v.eintraege, ctx))
export type KasseArtikelLayoutUpdate = z.infer<typeof KasseArtikelLayoutUpdateSchema>

/** Ein Artikel im Standard-Layout: Slot (artikel.raster_position) oder null = hinten anhängen. */
export const StandardRasterEintragSchema = z.object({
  artikelId: z.string().uuid(),
  position:  z.number().int().min(1).max(STANDARD_RASTER_MAX_POSITION).nullable(),
})
export type StandardRasterEintrag = z.infer<typeof StandardRasterEintragSchema>

/**
 * PUT /kategorien/:kategorieId/artikel-raster — setzt für die genannten Artikel einer Warengruppe
 * Slot (raster_position) und Reihenfolge (= Slot, wie der Layout-Import); null löscht den Slot.
 * Nicht genannte Artikel der Gruppe bleiben unverändert.
 */
export const StandardRasterUpdateSchema = z.object({
  eintraege: z.array(StandardRasterEintragSchema).max(KASSEN_LAYOUT_MAX_EINTRAEGE),
}).superRefine((v, ctx) => pruefeEindeutig(v.eintraege, ctx))
export type StandardRasterUpdate = z.infer<typeof StandardRasterUpdateSchema>
