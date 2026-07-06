import { z } from 'zod'
import { AngebotPositionSchema } from './angebot.js'
import { KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const LiferscheinStatusSchema = z.enum(['offen', 'abgeschlossen'])
export type  LiferscheinStatus = z.infer<typeof LiferscheinStatusSchema>

export const LIEFERSCHEIN_STATUS_LABELS: Record<LiferscheinStatus, string> = {
  offen:         'Offen',
  abgeschlossen: 'Abgeschlossen',
}

// ---------------------------------------------------------------------------
// Input / Update
// ---------------------------------------------------------------------------

/** Zuweisung von Seriennummern zu einer Position (Index in angebot.positionen). */
export const SerialZuweisungSchema = z.object({
  positionIndex: z.number().int().nonnegative(),
  seriennummern: z.array(z.string().trim().min(1)).min(1),
})
export type SerialZuweisung = z.infer<typeof SerialZuweisungSchema>

export const LiferscheinInputSchema = z.object({
  angebotId: z.string().uuid(),
  notiz:     z.string().trim().max(2000).optional(),
  /** Pro serialisierter Position die gewählten Seriennummern aus dem Pool */
  serialZuweisungen: z.array(SerialZuweisungSchema).optional(),
})
export type LiferscheinInput = z.infer<typeof LiferscheinInputSchema>

export const LiferscheinUpdateSchema = z.object({
  status: LiferscheinStatusSchema.optional(),
  notiz:  z.string().trim().max(2000).optional(),
})
export type LiferscheinUpdate = z.infer<typeof LiferscheinUpdateSchema>

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const LiferscheinResponseSchema = z.object({
  id:            z.string().uuid(),
  nummer:        z.number().int(),
  datum:         z.string(),
  status:        LiferscheinStatusSchema,
  angebotId:     z.string().uuid(),
  angebotNummer: z.number().int(),
  positionen:    z.array(AngebotPositionSchema),
  notiz:         z.string().optional(),
  kunde:         KundeSnapshotSchema.optional(),
  createdAt:     z.string(),
})
export type LiferscheinResponse = z.infer<typeof LiferscheinResponseSchema>

// ---------------------------------------------------------------------------
// Sammelrechnung
// ---------------------------------------------------------------------------

export const SammelrechnungInputSchema = z.object({
  lieferscheinIds: z.array(z.string().uuid()).min(1).max(100),
})
export type SammelrechnungInput = z.infer<typeof SammelrechnungInputSchema>

export const SammelrechnungResponseSchema = z.object({
  id:               z.string().uuid(),
  nummer:           z.number().int(),
  datum:            z.string(),
  kunde:            KundeSnapshotSchema.optional(),
  lieferscheine:    z.array(LiferscheinResponseSchema),
  gesamtbetragCent: z.number().int(),
  createdAt:        z.string(),
})
export type SammelrechnungResponse = z.infer<typeof SammelrechnungResponseSchema>
