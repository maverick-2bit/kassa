import { z } from 'zod'

// ---------------------------------------------------------------------------
// Kassenbuch — Bar-Einlagen und Entnahmen (nicht umsatzbezogen)
// ---------------------------------------------------------------------------

export const KassenbuchBuchungTypSchema = z.enum(['einlage', 'entnahme'])
export type KassenbuchBuchungTyp = z.infer<typeof KassenbuchBuchungTypSchema>

export const KASSENBUCH_TYP_LABELS: Record<KassenbuchBuchungTyp, string> = {
  einlage:  'Einlage',
  entnahme: 'Entnahme',
}

export const KassenbuchBuchungSchema = z.object({
  id:         z.string().uuid(),
  kasseId:    z.string().uuid(),
  typ:        KassenbuchBuchungTypSchema,
  betragCent: z.number().int().positive(),
  grund:      z.string().nullable(),
  userId:     z.string().uuid().nullable(),
  userName:   z.string().nullable(),
  datum:      z.string(), // YYYY-MM-DD (Buchungstag)
  createdAt:  z.string(),
})
export type KassenbuchBuchung = z.infer<typeof KassenbuchBuchungSchema>

export const KassenbuchBuchungInputSchema = z.object({
  kasseId:    z.string().uuid(),
  typ:        KassenbuchBuchungTypSchema,
  betragCent: z.number().int().min(1, 'Betrag muss mindestens 1 Cent sein'),
  grund:      z.string().trim().max(200).optional().nullable(),
  datum:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum'),
})
export type KassenbuchBuchungInput = z.infer<typeof KassenbuchBuchungInputSchema>

export const KassenbuchQuerySchema = z.object({
  kasseId: z.string().uuid(),
  von:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bis:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type KassenbuchQuery = z.infer<typeof KassenbuchQuerySchema>

export const KassenbuchResponseSchema = z.object({
  buchungen:     z.array(KassenbuchBuchungSchema),
  einlagenCent:  z.number().int(),
  entnahmenCent: z.number().int(),
  saldoCent:     z.number().int(), // einlagenCent - entnahmenCent
  von:           z.string(),
  bis:           z.string(),
})
export type KassenbuchResponse = z.infer<typeof KassenbuchResponseSchema>
