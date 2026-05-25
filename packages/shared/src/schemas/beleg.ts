import { z } from 'zod'
import { MwStSatzSchema } from './artikel.js'
import { FinanzOnlineCredentialsSchema } from './setup.js'
import { KundeInputSchema, KundeSnapshotSchema } from './kunde.js'

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

export const RabattInputSchema = z.discriminatedUnion('typ', [
  z.object({
    typ:         z.literal('prozent'),
    prozent:     z.number().int().min(1).max(100),
    bezeichnung: z.string().max(100).optional(),
  }),
  z.object({
    typ:         z.literal('betrag'),
    betragCent:  z.number().int().positive(),
    mwstSatz:    MwStSatzSchema.optional(),
    bezeichnung: z.string().max(100).optional(),
  }),
])
export type RabattInput = z.infer<typeof RabattInputSchema>

/** Position aus dem Artikelstamm */
export const ArtikelPositionSchema = z.object({
  artikelId:              z.string().uuid(),
  menge:                  z.number().positive('Menge muss positiv sein'),
  /** Preis-Override (Modifikatoren oder Rabatt; 0 = Artikel gratis) */
  einzelpreisBreuttoCent: z.number().int().nonnegative().optional(),
  /** Bezeichnungs-Zusatz, z. B. "(groß, Ketchup)" */
  bezeichnungZusatz:      z.string().max(200).optional(),
})
export type ArtikelPosition = z.infer<typeof ArtikelPositionSchema>

/** Freie Position ohne Artikel-Lookup (Tagesspecial, Korrektur, etc.) */
export const FreiePositionSchema = z.object({
  bezeichnung:     z.string().min(1).max(200).trim(),
  preisBruttoCent: z.number().int(),
  mwstSatz:        MwStSatzSchema,
  menge:           z.number().int().positive().default(1),
})
export type FreiePosition = z.infer<typeof FreiePositionSchema>

export const BelegInputPositionSchema = z.union([ArtikelPositionSchema, FreiePositionSchema])
export type BelegInputPosition = z.infer<typeof BelegInputPositionSchema>

export const BarzahlungsbelegInputSchema = z.object({
  kasseId:    z.string().uuid(),
  positionen: z.array(BelegInputPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  zahlung: z.object({
    barCent:      z.number().int().nonnegative(),
    karteCent:    z.number().int().nonnegative(),
    sonstigeCent: z.number().int().nonnegative(),
  }),
  rabatt:     RabattInputSchema.optional(),
  /** Bestehenden Kunden zuordnen */
  kundeId:    z.string().uuid().optional(),
  /** Neuen Kunden anlegen und direkt verknüpfen */
  neuerKunde: KundeInputSchema.optional(),
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

  /** Kunden-Snapshot zum Zeitpunkt der Buchung */
  kunde: KundeSnapshotSchema.optional(),

  createdAt: z.string(),
})
export type BelegResponse = z.infer<typeof BelegResponseSchema>
