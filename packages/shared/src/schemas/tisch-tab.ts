import { z } from 'zod'
import { ModifikatorAuswahlSchema } from './modifikator.js'

// ---------------------------------------------------------------------------
// Tab-Position (ein Artikel in einem offenen Tisch-Tab)
// ---------------------------------------------------------------------------

export const TabPositionSchema = z.object({
  artikelId:       z.string().uuid(),
  bezeichnung:     z.string(),
  preisBruttoCent: z.number().int().positive(),
  menge:           z.number().int().positive(),
  station:         z.string().optional(),
  /** Gewählte Modifikatoren (aufschlagCent bereits in preisBruttoCent eingerechnet) */
  modifikatoren:   z.array(ModifikatorAuswahlSchema).optional(),
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

export const TischTabUmbuchenInputSchema = z.object({
  tischNummer: z.string().trim().min(1).max(40),
})
export type TischTabUmbuchenInput = z.infer<typeof TischTabUmbuchenInputSchema>

export const TischTabUmbenennenInputSchema = z.object({
  kellner: z.string().trim().min(1).max(100),
})
export type TischTabUmbenennenInput = z.infer<typeof TischTabUmbenennenInputSchema>

export const TischTabSplitZahlungSchema = z.object({
  positionen: z.array(TabPositionSchema).min(1),
  zahlung: z.object({
    barCent:      z.number().int().nonnegative(),
    karteCent:    z.number().int().nonnegative(),
    sonstigeCent: z.number().int().nonnegative().default(0),
  }),
})

export const TischTabSplittenInputSchema = z.object({
  zahlungen: z.array(TischTabSplitZahlungSchema).min(2),
})
export type TischTabSplittenInput = z.infer<typeof TischTabSplittenInputSchema>

export const TischTabBezahlenInputSchema = z.object({
  zahlung: z.object({
    barCent:      z.number().int().nonnegative(),
    karteCent:    z.number().int().nonnegative(),
    sonstigeCent: z.number().int().nonnegative(),
  }),
})
export type TischTabBezahlenInput = z.infer<typeof TischTabBezahlenInputSchema>

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export const TabEreignisSchema = z.object({
  id:        z.string().uuid(),
  typ:       z.enum([
    'geoeffnet',
    'bonierung',
    'positionen_aktualisiert',
    'storno',
    'tisch_gewechselt',
    'kellner_umbenannt',
    'bezahlt',
    'gesplittet',
  ]),
  details:   z.record(z.unknown()),
  createdAt: z.string(),
})
export type TabEreignis = z.infer<typeof TabEreignisSchema>

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
