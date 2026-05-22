import { z } from 'zod'

// ---------------------------------------------------------------------------
// Farben – vordefinierte Farbschlüssel für Kategorie-Tabs
// ---------------------------------------------------------------------------

export const KategorieFarbeSchema = z.enum([
  'grau', 'rot', 'orange', 'gelb', 'gruen', 'blau', 'lila', 'pink',
])
export type KategorieFarbe = z.infer<typeof KategorieFarbeSchema>

export const KATEGORIE_FARBE_LABELS: Record<KategorieFarbe, string> = {
  grau:   'Grau',
  rot:    'Rot',
  orange: 'Orange',
  gelb:   'Gelb',
  gruen:  'Grün',
  blau:   'Blau',
  lila:   'Lila',
  pink:   'Pink',
}

// ---------------------------------------------------------------------------
// Kategorie
// ---------------------------------------------------------------------------

export const KategorieSchema = z.object({
  id:          z.string().uuid(),
  mandantId:   z.string().uuid(),
  name:        z.string(),
  farbe:       KategorieFarbeSchema,
  reihenfolge: z.number().int(),
  aktiv:       z.boolean(),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type Kategorie = z.infer<typeof KategorieSchema>

export const KategorieInputSchema = z.object({
  name:        z.string().trim().min(1, 'Name erforderlich').max(80),
  farbe:       KategorieFarbeSchema,
  reihenfolge: z.number().int().nonnegative().default(0),
})
export type KategorieInput = z.infer<typeof KategorieInputSchema>

export const KategorieUpdateSchema = z.object({
  name:        z.string().trim().min(1).max(80).optional(),
  farbe:       KategorieFarbeSchema.optional(),
  reihenfolge: z.number().int().nonnegative().optional(),
  aktiv:       z.boolean().optional(),
})
export type KategorieUpdate = z.infer<typeof KategorieUpdateSchema>
