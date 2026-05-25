import { z } from 'zod'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const LieferbestellungStatusSchema = z.enum([
  'neu',          // Eingegangen, wartet auf Bestätigung
  'bestaetigt',   // Bestätigt, wird zubereitet
  'fertig',       // Abholbereit / übergeben
  'abgelehnt',    // Abgelehnt (z. B. ausverkauft)
  'storniert',    // Nachträglich storniert
])
export type LieferbestellungStatus = z.infer<typeof LieferbestellungStatusSchema>

export const LIEFERBESTELLUNG_STATUS_LABELS: Record<LieferbestellungStatus, string> = {
  neu:         'Neu',
  bestaetigt:  'Bestätigt',
  fertig:      'Fertig',
  abgelehnt:   'Abgelehnt',
  storniert:   'Storniert',
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const LIEFERBESTELLUNG_PROVIDER_LABELS: Record<string, string> = {
  lieferando: 'Lieferando',
  mergeport:  'Mergeport',
  custom:     'Eigene Quelle',
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export const LieferbestellungPositionSchema = z.object({
  bezeichnung:            z.string(),
  menge:                  z.number().int().positive(),
  einzelpreisBreuttoCent: z.number().int().nonnegative(),
  notiz:                  z.string().optional(),
})
export type LieferbestellungPosition = z.infer<typeof LieferbestellungPositionSchema>

// ---------------------------------------------------------------------------
// Response (API → Frontend)
// ---------------------------------------------------------------------------

export const LieferbestellungResponseSchema = z.object({
  id:               z.string().uuid(),
  kasseId:          z.string().uuid(),
  externeId:        z.string(),
  provider:         z.string(),
  status:           LieferbestellungStatusSchema,
  positionen:       z.array(LieferbestellungPositionSchema),
  gesamtbetragCent: z.number().int(),
  lieferName:       z.string().optional(),
  lieferTelefon:    z.string().optional(),
  lieferAdresse:    z.string().optional(),
  notiz:            z.string().optional(),
  createdAt:        z.string(),
  updatedAt:        z.string(),
})
export type LieferbestellungResponse = z.infer<typeof LieferbestellungResponseSchema>

// ---------------------------------------------------------------------------
// Update (Status-Änderung)
// ---------------------------------------------------------------------------

export const LieferbestellungUpdateSchema = z.object({
  status: LieferbestellungStatusSchema,
})
export type LieferbestellungUpdate = z.infer<typeof LieferbestellungUpdateSchema>
