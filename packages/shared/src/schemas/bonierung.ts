/**
 * Bonierung = Bestellaufnahme.
 * Wird VOR der Rechnungserstellung an das KDS gesendet (Küche/Schank/...).
 * Erzeugt KEINEN RKSV-Beleg, sondern Bonierbons im Asello-Klartextformat.
 */

import { z } from 'zod'
import { StationSchema } from './station.js'

export const BonierungPositionSchema = z.object({
  artikelId: z.string().uuid(),
  menge:     z.number().int().positive(),
  details:   z.string().trim().max(120).optional(),
})

export const BonierungInputSchema = z.object({
  kasseId: z.string().uuid(),
  tisch:   z.string().trim().min(1).max(40),
  bereich: z.string().trim().max(60).optional(),
  kellner: z.string().trim().min(1).max(60),
  positionen: z.array(BonierungPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
})
export type BonierungInput = z.infer<typeof BonierungInputSchema>

export const BonierungErgebnisSchema = z.object({
  bonNummer:    z.string(),
  stationen: z.array(z.object({
    station:    StationSchema,
    ip:         z.string(),
    positionen: z.number().int(),
    erfolgreich: z.boolean(),
    fehler:     z.string().optional(),
  })),
})
export type BonierungErgebnis = z.infer<typeof BonierungErgebnisSchema>
