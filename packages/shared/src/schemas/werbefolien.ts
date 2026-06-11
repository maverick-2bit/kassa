import { z } from 'zod'

export const WerbefolieInputSchema = z.object({
  titel:           z.string().max(100).default(''),
  bildBase64:      z.string().min(10),
  mimeType:        z.string().regex(/^image\/(jpeg|png|webp|gif)$/).default('image/jpeg'),
  reihenfolge:     z.number().int().min(0).default(0),
  aktiv:           z.boolean().default(true),
  anzeigedauerSek: z.number().int().min(2).max(60).default(8),
})
export type WerbefolieInput = z.infer<typeof WerbefolieInputSchema>

export const WerbefolieUpdateSchema = WerbefolieInputSchema.partial()
export type WerbefolieUpdate = z.infer<typeof WerbefolieUpdateSchema>

export const WerbefolieResponseSchema = z.object({
  id:               z.string().uuid(),
  mandantId:        z.string().uuid(),
  titel:            z.string(),
  bildBase64:       z.string(),
  mimeType:         z.string(),
  reihenfolge:      z.number().int(),
  aktiv:            z.boolean(),
  anzeigedauerSek:  z.number().int(),
  createdAt:        z.string(),
  updatedAt:        z.string(),
})
export type WerbefolieResponse = z.infer<typeof WerbefolieResponseSchema>
