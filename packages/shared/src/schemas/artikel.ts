import { z } from 'zod'
import { StationSchema } from './station.js'

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
  id:                   z.string().uuid(),
  mandantId:            z.string().uuid(),
  bezeichnung:          z.string(),
  preisBruttoCent:      z.number().int(),
  mwstSatz:             MwStSatzSchema,
  artikelnummer:        z.string().nullable(),
  station:              StationSchema.nullable(),
  kategorieId:          z.string().uuid().nullable(),
  aktiv:                z.boolean(),
  lagerstandAktiv:      z.boolean(),
  lagerstandMenge:      z.number().int().nonnegative().nullable(),
  istFavorit:           z.boolean(),
  reihenfolge:          z.number().int(),
  favoritenReihenfolge: z.number().int(),
  bonierdruckerId:      z.string().uuid().nullable(),
  createdAt:            z.string(),
  updatedAt:            z.string(),
})
export type Artikel = z.infer<typeof ArtikelSchema>

export const ArtikelInputSchema = z.object({
  mandantId:       z.string().uuid(),
  bezeichnung:     z.string().trim().min(1, 'Bezeichnung erforderlich').max(200),
  preisBruttoCent: z.number().int().nonnegative('Preis darf nicht negativ sein'),
  mwstSatz:        MwStSatzSchema,
  // artikelnummer wird serverseitig automatisch generiert – nie vom Client gesetzt
  station:         StationSchema.optional().nullable(),
  kategorieId:     z.string().uuid().optional().nullable(),
  lagerstandAktiv: z.boolean().default(false),
  lagerstandMenge: z.number().int().nonnegative().nullable().default(null),
  istFavorit:      z.boolean().default(false),
  bonierdruckerId: z.string().uuid().optional().nullable(),
})
export type ArtikelInput = z.infer<typeof ArtikelInputSchema>

export const ArtikelUpdateSchema = z.object({
  bezeichnung:          z.string().trim().min(1).max(200).optional(),
  preisBruttoCent:      z.number().int().nonnegative().optional(),
  mwstSatz:             MwStSatzSchema.optional(),
  // artikelnummer ist schreibgeschützt (immer auto-generiert)
  station:              StationSchema.optional().nullable(),
  kategorieId:          z.string().uuid().optional().nullable(),
  aktiv:                z.boolean().optional(),
  lagerstandAktiv:      z.boolean().optional(),
  lagerstandMenge:      z.number().int().nonnegative().nullable().optional(),
  istFavorit:           z.boolean().optional(),
  reihenfolge:          z.number().int().nonnegative().optional(),
  favoritenReihenfolge: z.number().int().nonnegative().optional(),
  bonierdruckerId:      z.string().uuid().nullable().optional(),
})
export type ArtikelUpdate = z.infer<typeof ArtikelUpdateSchema>
