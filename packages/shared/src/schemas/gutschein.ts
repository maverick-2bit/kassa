import { z } from 'zod'
import { KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const GutscheinStatusSchema = z.enum(['aktiv', 'teileingeloest', 'eingeloest', 'storniert'])
export type GutscheinStatus = z.infer<typeof GutscheinStatusSchema>

export const GUTSCHEIN_STATUS_LABELS: Record<GutscheinStatus, string> = {
  aktiv:          'Aktiv',
  teileingeloest: 'Teileingelöst',
  eingeloest:     'Eingelöst',
  storniert:      'Storniert',
}

// ---------------------------------------------------------------------------
// Buchungs-Typen (Transaktionshistorie)
// ---------------------------------------------------------------------------

export const GutscheinBuchungTypSchema = z.enum([
  'ausstellung',   // Gutschein wurde ausgestellt
  'einloesung',    // Betrag eingelöst (Bar/Karte/Sonstiges)
  'restgutschein', // Restgutschein erstellt (bei Überzahlung)
  'storno',        // Gutschein storniert
])
export type GutscheinBuchungTyp = z.infer<typeof GutscheinBuchungTypSchema>

export const GUTSCHEIN_BUCHUNG_TYP_LABELS: Record<GutscheinBuchungTyp, string> = {
  ausstellung:   'Ausstellung',
  einloesung:    'Einlösung',
  restgutschein: 'Restgutschein erstellt',
  storno:        'Stornierung',
}

export const GutscheinBuchungResponseSchema = z.object({
  id:                      z.string().uuid(),
  gutscheinId:             z.string().uuid(),
  typ:                     GutscheinBuchungTypSchema,
  /** Positiv = Gut (Ausstellung), negativ = Belastung (Einlösung/Storno) */
  betragCent:              z.number().int(),
  restCentNach:            z.number().int(),
  belegId:                 z.string().uuid().optional(),
  verknuepfterGutscheinId: z.string().uuid().optional(),
  notiz:                   z.string().optional(),
  createdAt:               z.string(),
})
export type GutscheinBuchungResponse = z.infer<typeof GutscheinBuchungResponseSchema>

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const GutscheinInputSchema = z.object({
  betragCent: z.number().int().positive(),
  /** Optionaler benutzerdefinierter Code (EAN/QR-Code). Leer = automatisch generieren. */
  code:       z.string().trim().min(1).max(50).optional(),
  gueltigBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD
  kundeId:    z.string().uuid().optional(),
  notiz:      z.string().trim().max(2000).optional(),
})
export type GutscheinInput = z.infer<typeof GutscheinInputSchema>

/** Betrag einlösen (ganz oder teilweise) */
export const GutscheinEinloesenSchema = z.object({
  einloesungCent:      z.number().int().positive(),
  /**
   * Wenn true und einloesungCent < restCent: Original-Gutschein wird als eingelöst markiert
   * und ein neuer Gutschein über den Restbetrag ausgestellt.
   */
  erstelleRestgutschein: z.boolean().default(false),
  /** Optional: Beleg-ID für die Buchungsreferenz */
  belegId:             z.string().uuid().optional(),
})
export type GutscheinEinloesen = z.infer<typeof GutscheinEinloesenSchema>

export const GutscheinResponseSchema = z.object({
  id:          z.string().uuid(),
  code:        z.string(),
  nummer:      z.number().int(),
  datum:       z.string(),
  status:      GutscheinStatusSchema,
  betragCent:  z.number().int(),
  bezahltCent: z.number().int(),
  restCent:    z.number().int(),
  gueltigBis:  z.string().optional(),
  kundeId:     z.string().uuid().nullable().optional(),
  kunde:       KundeSnapshotSchema.optional(),
  notiz:       z.string().optional(),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type GutscheinResponse = z.infer<typeof GutscheinResponseSchema>

/** Ergebnis einer Einlösung — enthält ggf. neuen Restgutschein */
export const GutscheinEinloesungResultSchema = z.object({
  gutschein:     GutscheinResponseSchema,
  restGutschein: GutscheinResponseSchema.optional(),
})
export type GutscheinEinloesungResult = z.infer<typeof GutscheinEinloesungResultSchema>
