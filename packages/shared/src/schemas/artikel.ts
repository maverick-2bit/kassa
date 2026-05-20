import { z } from 'zod'

/** Österreichische MwSt-Sätze gemäß RKSV */
export const MwStSatzSchema = z.enum(['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders'])
export type MwStSatz = z.infer<typeof MwStSatzSchema>

export const MWST_LABELS: Record<MwStSatz, string> = {
  normal:      '20 % (Normal)',
  ermaessigt1: '10 % (Ermäßigt)',
  ermaessigt2: '13 % (Ermäßigt 2)',
  null:        '0 %',
  besonders:   '19 % (Sondersteuersatz)',
}

// ---------------------------------------------------------------------------
// Artikel
// ---------------------------------------------------------------------------

export const ArtikelSchema = z.object({
  id:              z.string().uuid(),
  mandantId:       z.string().uuid(),
  bezeichnung:     z.string(),
  preisBruttoCent: z.number().int(),
  mwstSatz:        MwStSatzSchema,
  artikelnummer:   z.string().nullable(),
  aktiv:           z.boolean(),
  createdAt:       z.string(),
  updatedAt:       z.string(),
})
export type Artikel = z.infer<typeof ArtikelSchema>

export const ArtikelInputSchema = z.object({
  mandantId:       z.string().uuid(),
  bezeichnung:     z.string().trim().min(1, 'Bezeichnung erforderlich').max(200),
  preisBruttoCent: z.number().int().nonnegative('Preis darf nicht negativ sein'),
  mwstSatz:        MwStSatzSchema,
  artikelnummer:   z.string().trim().max(40).optional().nullable(),
})
export type ArtikelInput = z.infer<typeof ArtikelInputSchema>

export const ArtikelUpdateSchema = z.object({
  bezeichnung:     z.string().trim().min(1).max(200).optional(),
  preisBruttoCent: z.number().int().nonnegative().optional(),
  mwstSatz:        MwStSatzSchema.optional(),
  artikelnummer:   z.string().trim().max(40).optional().nullable(),
  aktiv:           z.boolean().optional(),
})
export type ArtikelUpdate = z.infer<typeof ArtikelUpdateSchema>
