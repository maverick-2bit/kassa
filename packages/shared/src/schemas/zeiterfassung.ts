import { z } from 'zod'

export const Arbeitszeit_QuelleSchema = z.enum(['pin', 'admin'])
export type ArbeitszeiteQuelle = z.infer<typeof Arbeitszeit_QuelleSchema>

export const ArbeitszeitInputSchema = z.object({
  kasseId:       z.string().uuid(),
  userId:        z.string().uuid(),
  beginn:        z.string().datetime(),
  ende:          z.string().datetime().optional(),
  pauseMinuten:  z.number().int().min(0).max(480).optional(),
  notiz:         z.string().max(300).optional(),
})
export type ArbeitszeitInput = z.infer<typeof ArbeitszeitInputSchema>

export const ArbeitszeitUpdateSchema = z.object({
  beginn:        z.string().datetime().optional(),
  ende:          z.string().datetime().optional(),
  pauseMinuten:  z.number().int().min(0).max(480).optional(),
  notiz:         z.string().max(300).optional(),
})
export type ArbeitszeitUpdate = z.infer<typeof ArbeitszeitUpdateSchema>

export const ArbeitszeitResponseSchema = z.object({
  id:            z.string().uuid(),
  kasseId:       z.string().uuid(),
  userId:        z.string().uuid(),
  userName:      z.string(),
  beginn:        z.string(),
  ende:          z.string().nullable(),
  dauerMinuten:  z.number().int().nullable(),
  pauseMinuten:  z.number().int(),
  nettoMinuten:  z.number().int().nullable(),
  notiz:         z.string().optional(),
  quelle:        Arbeitszeit_QuelleSchema,
  createdAt:     z.string(),
  updatedAt:     z.string(),
})
export type ArbeitszeitResponse = z.infer<typeof ArbeitszeitResponseSchema>

// PIN-Stempel-Endpoint
export const StempelInputSchema = z.object({
  kasseId: z.string().uuid(),
  pin:     z.string().min(3).max(8),
})
export type StempelInput = z.infer<typeof StempelInputSchema>

export const StempelResponseSchema = z.object({
  aktion:   z.enum(['eingestempelt', 'ausgestempelt']),
  userId:   z.string().uuid(),
  userName: z.string(),
  zeitpunkt: z.string(),
  beginn:   z.string().optional(),
  ende:     z.string().optional(),
  dauerMinuten: z.number().int().optional(),
})
export type StempelResponse = z.infer<typeof StempelResponseSchema>
