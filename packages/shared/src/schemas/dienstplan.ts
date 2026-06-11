import { z } from 'zod'

export const DienstplanStatusSchema = z.enum(['geplant', 'bestaetigt', 'krank', 'abwesend'])
export type DienstplanStatus = z.infer<typeof DienstplanStatusSchema>

export const DIENSTPLAN_STATUS_LABELS: Record<DienstplanStatus, string> = {
  geplant:    'Geplant',
  bestaetigt: 'Bestätigt',
  krank:      'Krank',
  abwesend:   'Abwesend',
}

export const DienstplanSchichtInputSchema = z.object({
  kasseId:       z.string().uuid(),
  userId:        z.string().uuid(),
  datum:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  beginnGeplant: z.string().regex(/^\d{2}:\d{2}$/),
  endeGeplant:   z.string().regex(/^\d{2}:\d{2}$/),
  position:      z.string().max(100).optional(),
  notiz:         z.string().max(500).optional(),
})
export type DienstplanSchichtInput = z.infer<typeof DienstplanSchichtInputSchema>

export const DienstplanSchichtUpdateSchema = DienstplanSchichtInputSchema.partial().extend({
  status: DienstplanStatusSchema.optional(),
})
export type DienstplanSchichtUpdate = z.infer<typeof DienstplanSchichtUpdateSchema>

export const DienstplanSchichtResponseSchema = z.object({
  id:            z.string().uuid(),
  mandantId:     z.string().uuid(),
  kasseId:       z.string().uuid(),
  userId:        z.string().uuid(),
  userName:      z.string(),
  datum:         z.string(),
  beginnGeplant: z.string(),
  endeGeplant:   z.string(),
  position:      z.string().nullable(),
  notiz:         z.string().nullable(),
  status:        DienstplanStatusSchema,
  dauerMinuten:  z.number().int(),
  createdAt:     z.string(),
  updatedAt:     z.string(),
})
export type DienstplanSchichtResponse = z.infer<typeof DienstplanSchichtResponseSchema>
