import { z } from 'zod'
import { MwStSatzSchema } from './artikel.js'
import { FinanzOnlineCredentialsSchema } from './setup.js'

// ---------------------------------------------------------------------------
// Beleg-Position (im Bon enthaltene Zeile)
// ---------------------------------------------------------------------------

export const BelegPositionSchema = z.object({
  bezeichnung:        z.string(),
  menge:              z.number().positive(),
  einzelpreisBreutto: z.number().int(),
  mwstSatz:           MwStSatzSchema,
})
export type BelegPositionDto = z.infer<typeof BelegPositionSchema>

// ---------------------------------------------------------------------------
// Barzahlungsbeleg-Anfrage
// ---------------------------------------------------------------------------

export const BarzahlungsbelegInputSchema = z.object({
  kasseId: z.string().uuid(),
  positionen: z.array(z.object({
    artikelId: z.string().uuid(),
    menge:     z.number().positive('Menge muss positiv sein'),
  })).min(1, 'Mindestens eine Position erforderlich'),
  zahlung: z.object({
    barCent:      z.number().int().nonnegative(),
    karteCent:    z.number().int().nonnegative(),
    sonstigeCent: z.number().int().nonnegative(),
  }),
})
export type BarzahlungsbelegInput = z.infer<typeof BarzahlungsbelegInputSchema>

// ---------------------------------------------------------------------------
// Stornobeleg — Komplett-Storno eines vorherigen Belegs
// ---------------------------------------------------------------------------

export const StornobelegInputSchema = z.object({
  kasseId:        z.string().uuid(),
  verweisBelegId: z.string().uuid(),
  /** Optional: Grund (für interne Dokumentation, nicht im Bon-QR-Code) */
  grund:          z.string().trim().max(200).optional(),
})
export type StornobelegInput = z.infer<typeof StornobelegInputSchema>

// ---------------------------------------------------------------------------
// Nullbeleg — Test-/Kontrollbeleg ohne Umsatz
// ---------------------------------------------------------------------------

export const NullbelegInputSchema = z.object({
  kasseId: z.string().uuid(),
})
export type NullbelegInput = z.infer<typeof NullbelegInputSchema>

// ---------------------------------------------------------------------------
// Monatsbeleg — Monatsabschluss (RKSV-Pflicht)
// ---------------------------------------------------------------------------

export const MonatsbelegInputSchema = z.object({
  kasseId: z.string().uuid(),
})
export type MonatsbelegInput = z.infer<typeof MonatsbelegInputSchema>

// ---------------------------------------------------------------------------
// Jahresbeleg — Jahresabschluss (RKSV-Pflicht + FinanzOnline-Prüfung)
// ---------------------------------------------------------------------------

export const JahresbelegInputSchema = z.object({
  kasseId: z.string().uuid(),
  /** Optional: wenn gesetzt, wird der Jahresbeleg direkt bei FinanzOnline geprüft */
  finanzOnline: FinanzOnlineCredentialsSchema.optional(),
})
export type JahresbelegInput = z.infer<typeof JahresbelegInputSchema>

// ---------------------------------------------------------------------------
// Beleg-Response
// ---------------------------------------------------------------------------

export const BelegResponseSchema = z.object({
  id:           z.string().uuid(),
  belegNummer:  z.number().int(),
  belegDatum:   z.string(),
  belegTyp:     z.string(),

  betraege: z.object({
    normal:      z.number().int(),
    ermaessigt1: z.number().int(),
    ermaessigt2: z.number().int(),
    null:        z.number().int(),
    besonders:   z.number().int(),
  }),

  summeBarCent:      z.number().int(),
  summeKarteCent:    z.number().int(),
  summeSonstigeCent: z.number().int(),
  gesamtbetragCent:  z.number().int(),

  positionen: z.array(BelegPositionSchema),

  /** Nur bei Stornobeleg: ID des Original-Belegs */
  verweisBelegId: z.string().uuid().optional(),

  zertifikatSn:                z.string(),
  sigVorbeleg:                 z.string(),
  signaturwert:                z.string(),
  umsatzzaehlerVerschluesselt: z.string(),
  maschinenlesbareCode:        z.string(),

  createdAt: z.string(),
})
export type BelegResponse = z.infer<typeof BelegResponseSchema>
