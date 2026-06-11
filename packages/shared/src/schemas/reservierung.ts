import { z } from 'zod'

export const ReservierungStatusSchema = z.enum([
  'wartend',
  'bestaetigt',
  'erschienen',
  'nicht_erschienen',
  'storniert',
])
export type ReservierungStatus = z.infer<typeof ReservierungStatusSchema>

export const RESERVIERUNG_STATUS_LABELS: Record<ReservierungStatus, string> = {
  wartend:          'Anfrage',
  bestaetigt:       'Bestätigt',
  erschienen:       'Erschienen',
  nicht_erschienen: 'Nicht erschienen',
  storniert:        'Storniert',
}

export const ReservierungQuelleSchema = z.enum(['intern', 'online'])
export type ReservierungQuelle = z.infer<typeof ReservierungQuelleSchema>

export const ReservierungInputSchema = z.object({
  kasseId:        z.string().uuid(),
  datum:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  zeitVon:        z.string().regex(/^\d{2}:\d{2}$/),
  dauer:          z.number().int().min(15).max(480).optional(),
  personenAnzahl: z.number().int().min(1).max(100),
  name:           z.string().min(1).max(100),
  telefon:        z.string().max(30).optional(),
  email:          z.string().email().optional(),
  notiz:          z.string().max(500).optional(),
  tischLabel:     z.string().max(50).optional(),
})
export type ReservierungInput = z.infer<typeof ReservierungInputSchema>

export const ReservierungUpdateSchema = z.object({
  datum:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  zeitVon:        z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dauer:          z.number().int().min(15).max(480).optional(),
  personenAnzahl: z.number().int().min(1).max(100).optional(),
  name:           z.string().min(1).max(100).optional(),
  telefon:        z.string().max(30).optional(),
  email:          z.string().email().optional(),
  notiz:          z.string().max(500).optional(),
  tischLabel:     z.string().max(50).optional(),
  status:         ReservierungStatusSchema.optional(),
})
export type ReservierungUpdate = z.infer<typeof ReservierungUpdateSchema>

export const ReservierungResponseSchema = z.object({
  id:             z.string().uuid(),
  kasseId:        z.string().uuid(),
  datum:          z.string(),
  zeitVon:        z.string(),
  dauer:          z.number().int(),
  personenAnzahl: z.number().int(),
  name:           z.string(),
  telefon:        z.string().optional(),
  email:          z.string().optional(),
  notiz:          z.string().optional(),
  tischLabel:     z.string().optional(),
  status:         ReservierungStatusSchema,
  quelle:         ReservierungQuelleSchema,
  onlineToken:    z.string().uuid().optional(),
  createdAt:      z.string(),
  updatedAt:      z.string(),
})
export type ReservierungResponse = z.infer<typeof ReservierungResponseSchema>

// Öffentliche Buchungsinfo (kein JWT)
export const OnlineBuchungInfoSchema = z.object({
  kasseId:      z.string().uuid(),
  firmenname:   z.string(),
  aktiv:        z.boolean(),
})
export type OnlineBuchungInfo = z.infer<typeof OnlineBuchungInfoSchema>

// Öffentliche Buchungseingabe (kein JWT)
export const OnlineBuchungInputSchema = z.object({
  datum:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  zeitVon:        z.string().regex(/^\d{2}:\d{2}$/),
  personenAnzahl: z.number().int().min(1).max(100),
  name:           z.string().min(1).max(100),
  telefon:        z.string().max(30).optional(),
  email:          z.string().email().optional(),
  notiz:          z.string().max(500).optional(),
})
export type OnlineBuchungInput = z.infer<typeof OnlineBuchungInputSchema>
