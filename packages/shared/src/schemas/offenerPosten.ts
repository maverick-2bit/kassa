import { z } from 'zod'
import { KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const OffenerPostenStatusSchema = z.enum(['offen', 'teilbezahlt', 'bezahlt'])
export type OffenerPostenStatus = z.infer<typeof OffenerPostenStatusSchema>

export const OFFENER_POSTEN_STATUS_LABELS: Record<OffenerPostenStatus, string> = {
  offen:       'Offen',
  teilbezahlt: 'Teilbezahlt',
  bezahlt:     'Bezahlt',
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Vom Frontend/Backend beim Erstellen eines Offenen Postens */
export const OffenerPostenInputSchema = z.object({
  kundeId:    z.string().uuid(),
  belegId:    z.string().uuid().optional(),
  betragCent: z.number().int().positive(),
  notiz:      z.string().trim().max(2000).optional(),
})
export type OffenerPostenInput = z.infer<typeof OffenerPostenInputSchema>

/** Zahlung auf einen Offenen Posten */
export const OffenerPostenZahlungSchema = z.object({
  zahlungCent: z.number().int().positive(),
  notiz:       z.string().trim().max(2000).optional(),
})
export type OffenerPostenZahlung = z.infer<typeof OffenerPostenZahlungSchema>

/** Antwort-DTO */
export const OffenerPostenResponseSchema = z.object({
  id:          z.string().uuid(),
  nummer:      z.number().int(),
  datum:       z.string(),
  status:      OffenerPostenStatusSchema,
  kundeId:     z.string().uuid().nullable(),
  kunde:       KundeSnapshotSchema.optional(),
  belegId:     z.string().uuid().nullable().optional(),
  belegNummer: z.number().int().nullable().optional(),
  betragCent:  z.number().int(),
  bezahltCent: z.number().int(),
  restCent:    z.number().int(),
  notiz:       z.string().optional(),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type OffenerPostenResponse = z.infer<typeof OffenerPostenResponseSchema>
