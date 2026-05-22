import { z } from 'zod'

// ---------------------------------------------------------------------------
// Tab-Position (ein Artikel in einem offenen Tisch-Tab)
// ---------------------------------------------------------------------------

export const TabPositionSchema = z.object({
  artikelId:       z.string().uuid(),
  bezeichnung:     z.string(),
  preisBruttoCent: z.number().int().positive(),
  menge:           z.number().int().positive(),
  station:         z.string().optional(),
})
export type TabPosition = z.infer<typeof TabPositionSchema>

// ---------------------------------------------------------------------------
// Input-Schemas
// ---------------------------------------------------------------------------

export const TischTabErstellenInputSchema = z.object({
  kasseId:     z.string().uuid(),
  tischNummer: z.string().min(1).max(40).trim(),
  kellner:     z.string().min(1).max(100).trim(),
})
export type TischTabErstellenInput = z.infer<typeof TischTabErstellenInputSchema>

export const TischTabPositionenUpdateSchema = z.object({
  positionen: z.array(TabPositionSchema),
})
export type TischTabPositionenUpdate = z.infer<typeof TischTabPositionenUpdateSchema>

export const TischTabBezahlenInputSchema = z.object({
  zahlung: z.object({
    barCent:      z.number().int().nonnegative(),
    karteCent:    z.number().int().nonnegative(),
    sonstigeCent: z.number().int().nonnegative(),
  }),
})
export type TischTabBezahlenInput = z.infer<typeof TischTabBezahlenInputSchema>

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const TischTabResponseSchema = z.object({
  id:              z.string().uuid(),
  kasseId:         z.string().uuid(),
  tischNummer:     z.string(),
  kellner:         z.string(),
  positionen:      z.array(TabPositionSchema),
  status:          z.enum(['offen', 'bezahlt']),
  summeGesamtCent: z.number().int(),
  geoffnetAm:      z.string(),
  createdAt:       z.string(),
  updatedAt:       z.string(),
})
export type TischTabResponse = z.infer<typeof TischTabResponseSchema>
