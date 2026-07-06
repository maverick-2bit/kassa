import { z } from 'zod'

// ---------------------------------------------------------------------------
// Seriennummern — striktes Pool-Modell PRO ARTIKEL.
//
// Beim Wareneingang werden die Seriennummern der Stücke erfasst (Status
// 'verfuegbar'); der Lagerstand eines seriennummern-geführten Artikels ist die
// Anzahl freier Seriennummern. Beim Verkauf (Lieferschein/Rechnung) werden
// konkrete Seriennummern aus dem freien Pool gewählt → 'verkauft' + Verweis.
// ---------------------------------------------------------------------------

export const SeriennummerStatusSchema = z.enum(['verfuegbar', 'verkauft'])
export type SeriennummerStatus = z.infer<typeof SeriennummerStatusSchema>

export const SeriennummerSchema = z.object({
  id:             z.string().uuid(),
  artikelId:      z.string().uuid(),
  seriennummer:   z.string(),
  status:         SeriennummerStatusSchema,
  /** Bei Verkauf über eine Rechnung/Beleg */
  belegId:        z.string().uuid().nullable(),
  /** Bei Verkauf über einen Lieferschein */
  lieferscheinId: z.string().uuid().nullable(),
  verkauftAm:     z.string().nullable(),
  createdAt:      z.string(),
})
export type Seriennummer = z.infer<typeof SeriennummerSchema>

/** Seriennummern für einen Artikel erfassen (Wareneingang). */
export const SeriennummernErfassenInputSchema = z.object({
  artikelId:    z.string().uuid(),
  seriennummern: z.array(z.string().trim().min(1).max(100)).min(1).max(1000),
})
export type SeriennummernErfassenInput = z.infer<typeof SeriennummernErfassenInputSchema>
