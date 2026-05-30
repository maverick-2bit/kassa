import { z } from 'zod'

export const LieferantSchema = z.object({
  id:        z.string().uuid(),
  mandantId: z.string().uuid(),
  name:      z.string(),
  kontakt:   z.string().nullable(),
  email:     z.string().nullable(),
  telefon:   z.string().nullable(),
  notiz:     z.string().nullable(),
  aktiv:     z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Lieferant = z.infer<typeof LieferantSchema>

export const LieferantInputSchema = z.object({
  name:    z.string().trim().min(1, 'Name erforderlich').max(200),
  kontakt: z.string().max(200).optional().nullable(),
  email:   z.string().email('Ungültige E-Mail').max(200).optional().nullable(),
  telefon: z.string().max(50).optional().nullable(),
  notiz:   z.string().optional().nullable(),
})
export type LieferantInput = z.infer<typeof LieferantInputSchema>

export const LieferantUpdateSchema = LieferantInputSchema.partial().extend({
  aktiv: z.boolean().optional(),
})
export type LieferantUpdate = z.infer<typeof LieferantUpdateSchema>
