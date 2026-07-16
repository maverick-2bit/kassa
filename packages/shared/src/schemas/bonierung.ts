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
  /** Optionaler Verweis auf den Tisch-Tab — wenn gesetzt, wird das Ereignis im Verlauf protokolliert */
  tabId:   z.string().uuid().optional(),
  /** Tischbezeichnung. Optional: leer = Direktverkauf an der Schank (Bon-Label „Direkt"). */
  tisch:   z.string().trim().max(40).optional(),
  bereich: z.string().trim().max(60).optional(),
  kellner: z.string().trim().min(1).max(60),
  positionen: z.array(BonierungPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  /**
   * Nur drucken (KDS + Bonierdrucker), KEIN Lagerabzug. Für Tisch-Bonierungen
   * (Parken/Sofort-Kassieren) — dort zieht aktualisiereStockDeltas den Lagerstand
   * bereits ab; ohne dieses Flag käme es zum Doppel-Abzug.
   */
  ohneLagerabzug: z.boolean().optional(),
})
export type BonierungInput = z.infer<typeof BonierungInputSchema>

export const BonierungErgebnisSchema = z.object({
  bonNummer:    z.string(),
  stationen: z.array(z.object({
    station:     StationSchema,
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
  })),
  /** Ergebnisse für ESC/POS Bonierdrucker (inkl. Backup-Drucker) */
  drucker: z.array(z.object({
    druckerId:   z.string().uuid(),
    name:        z.string(),
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
    istBackup:   z.boolean(),
  })).default([]),
})
export type BonierungErgebnis = z.infer<typeof BonierungErgebnisSchema>
