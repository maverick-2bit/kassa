import { z } from 'zod'
import { MwStSatzSchema } from './artikel.js'
import { KundeInputSchema, KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Position (pre-resolved — Frontend schickt bereits aufgelöste Daten)
// ---------------------------------------------------------------------------

export const AngebotPositionSchema = z.object({
  bezeichnung:        z.string().min(1).max(200).trim(),
  menge:              z.number().positive(),
  einzelpreisBreutto: z.number().int(),
  mwstSatz:           MwStSatzSchema,
  /** Referenz auf den Artikel (für Seriennummern-Zuordnung; fehlt bei freien Positionen) */
  artikelId:          z.string().uuid().optional(),
  /** Zugewiesene Seriennummern (auf Lieferschein/Rechnung; für den Aufdruck) */
  seriennummern:      z.array(z.string()).optional(),
})
export type AngebotPosition = z.infer<typeof AngebotPositionSchema>

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const AngebotInputSchema = z.object({
  kasseId:    z.string().uuid(),
  positionen: z.array(AngebotPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  gueltigBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notiz:      z.string().trim().max(2000).optional(),
  kundeId:    z.string().uuid().optional(),
  neuerKunde: KundeInputSchema.optional(),
})
export type AngebotInput = z.infer<typeof AngebotInputSchema>

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const AngebotStatusSchema = z.enum(['offen', 'angenommen', 'abgelehnt', 'abgelaufen'])
export type AngebotStatus = z.infer<typeof AngebotStatusSchema>

export const ANGEBOT_STATUS_LABELS: Record<AngebotStatus, string> = {
  offen:       'Offen',
  angenommen:  'Angenommen',
  abgelehnt:   'Abgelehnt',
  abgelaufen:  'Abgelaufen',
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const AngebotResponseSchema = z.object({
  id:               z.string().uuid(),
  nummer:           z.number().int(),
  datum:            z.string(),
  gueltigBis:       z.string().optional(),
  status:           AngebotStatusSchema,
  positionen:       z.array(AngebotPositionSchema),
  gesamtbetragCent: z.number().int(),
  notiz:            z.string().optional(),
  kunde:            KundeSnapshotSchema.optional(),
  createdAt:        z.string(),
})
export type AngebotResponse = z.infer<typeof AngebotResponseSchema>

// ---------------------------------------------------------------------------
// Update (Status-Änderung)
// ---------------------------------------------------------------------------

export const AngebotUpdateSchema = z.object({
  status:     AngebotStatusSchema.optional(),
  gueltigBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notiz:      z.string().trim().max(2000).optional(),
})
export type AngebotUpdate = z.infer<typeof AngebotUpdateSchema>
