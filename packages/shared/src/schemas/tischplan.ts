import { z } from 'zod'

export const TischplanFormSchema  = z.enum(['rechteck', 'rund'])
export type TischplanForm = z.infer<typeof TischplanFormSchema>

export const TISCHPLAN_FORM_LABELS: Record<TischplanForm, string> = {
  rechteck: 'Rechteck',
  rund:     'Rund',
}

export const TischplanFarbeSchema = z.enum(['grau', 'rot', 'orange', 'gelb', 'gruen', 'blau', 'lila', 'pink'])
export type TischplanFarbe = z.infer<typeof TischplanFarbeSchema>

export const TISCHPLAN_FARBE_LABELS: Record<TischplanFarbe, string> = {
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
// Element (ein Tisch auf der Planfläche)
// ---------------------------------------------------------------------------

export const TischplanElementSchema = z.object({
  id:          z.string().uuid(),
  bereichId:   z.string().uuid(),
  bezeichnung: z.string(),
  form:        TischplanFormSchema,
  farbe:       TischplanFarbeSchema,
  x:           z.number(),
  y:           z.number(),
  breite:      z.number(),
  hoehe:       z.number(),
})
export type TischplanElement = z.infer<typeof TischplanElementSchema>

export const TischplanElementErstellenSchema = z.object({
  kasseId:     z.string().uuid(),
  bereichId:   z.string().uuid(),
  bezeichnung: z.string().trim().min(1).max(40),
  form:        TischplanFormSchema.default('rechteck'),
  farbe:       TischplanFarbeSchema.default('grau'),
  x:           z.number().min(0).max(95).default(10),
  y:           z.number().min(0).max(95).default(10),
  breite:      z.number().min(4).max(40).default(10),
  hoehe:       z.number().min(4).max(40).default(8),
})
export type TischplanElementErstellen = z.infer<typeof TischplanElementErstellenSchema>

export const TischplanElementAktualisierenSchema = z.object({
  bezeichnung: z.string().trim().min(1).max(40).optional(),
  form:        TischplanFormSchema.optional(),
  farbe:       TischplanFarbeSchema.optional(),
  x:           z.number().min(0).max(95).optional(),
  y:           z.number().min(0).max(95).optional(),
  breite:      z.number().min(4).max(40).optional(),
  hoehe:       z.number().min(4).max(40).optional(),
})
export type TischplanElementAktualisieren = z.infer<typeof TischplanElementAktualisierenSchema>

// ---------------------------------------------------------------------------
// Bereich (Raum / Zone)
// ---------------------------------------------------------------------------

export const TischplanBereichSchema = z.object({
  id:          z.string().uuid(),
  kasseId:     z.string().uuid(),
  name:        z.string(),
  reihenfolge: z.number().int(),
  elemente:    z.array(TischplanElementSchema),
})
export type TischplanBereich = z.infer<typeof TischplanBereichSchema>

export const TischplanBereichErstellenSchema = z.object({
  kasseId: z.string().uuid(),
  name:    z.string().trim().min(1).max(60),
})
export type TischplanBereichErstellen = z.infer<typeof TischplanBereichErstellenSchema>

export const TischplanBereichAktualisierenSchema = z.object({
  name:        z.string().trim().min(1).max(60).optional(),
  reihenfolge: z.number().int().min(0).optional(),
})
export type TischplanBereichAktualisieren = z.infer<typeof TischplanBereichAktualisierenSchema>
