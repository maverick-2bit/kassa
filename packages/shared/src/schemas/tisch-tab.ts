import { z } from 'zod'
import { ModifikatorAuswahlSchema } from './modifikator.js'
import { RabattInputSchema } from './beleg.js'

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

// Mehrere offene Tabs (Gruppen) in einen Ziel-Tab zusammenführen.
export const TischTabZusammenfuehrenInputSchema = z.object({
  quellTabIds: z.array(z.string().uuid()).min(1).max(20),
})
export type TischTabZusammenfuehrenInput = z.infer<typeof TischTabZusammenfuehrenInputSchema>

// Teilweises Umbuchen: eine Teilmenge von Positionen auf einen anderen offenen Tisch
// (per Tischnummer) verschieben. Existiert dort kein offener Tab, wird er angelegt.
export const TischTabVerschiebenInputSchema = z.object({
  zielTischNummer: z.string().trim().min(1).max(40),
  positionen:      z.array(TabPositionSchema).min(1, 'Mindestens eine Position wählen'),
})
export type TischTabVerschiebenInput = z.infer<typeof TischTabVerschiebenInputSchema>

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
  rabatt: RabattInputSchema.optional(),
  /** Preis-Overrides pro Position (Index = Reihenfolge in tab.positionen) */
  positionRabatte: z.array(z.object({
    positionIndex:          z.number().int().nonnegative(),
    einzelpreisBreuttoCent: z.number().int().nonnegative(),
  })).optional(),
  /** Trinkgeld in Cent — wird als freie Position (0 % MwSt) auf den Beleg gebucht */
  trinkgeldCent: z.number().int().nonnegative().optional(),
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
    'zusammengefuehrt',
    'positionen_verschoben',
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
  status:          z.enum(['offen', 'bezahlt', 'zusammengefuehrt']),
  summeGesamtCent: z.number().int(),
  geoffnetAm:      z.string(),
  createdAt:       z.string(),
  updatedAt:       z.string(),
})
export type TischTabResponse = z.infer<typeof TischTabResponseSchema>
