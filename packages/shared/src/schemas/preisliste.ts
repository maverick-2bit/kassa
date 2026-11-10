import { z } from 'zod'

/**
 * Preislisten — Sonderpreise für bestimmte Kunden (z. B. „Tersus").
 *
 * Eine Preisliste enthält je Artikel einen eigenen Verkaufspreis (brutto, in Cent). Ein Kunde kann genau eine
 * Preisliste haben (manuell zugewiesen). Wird er an der Kasse gewählt, gilt für alle Artikel mit Eintrag der
 * Listenpreis, für alle anderen der normale Preis. Ein Listenpreis ersetzt den Artikelpreis; zeitgesteuerte
 * Aktionen (Happy Hour) kommen dann NICHT zusätzlich drauf.
 */

export const PreislisteSchema = z.object({
  id:           z.string().guid(),
  mandantId:    z.string().guid(),
  name:         z.string(),
  aktiv:        z.boolean(),
  anzahlPreise: z.number().int().nonnegative(),
  /** Zugewiesene (aktive) Kunden */
  anzahlKunden: z.number().int().nonnegative(),
  createdAt:    z.string(),
  updatedAt:    z.string(),
})
export type Preisliste = z.infer<typeof PreislisteSchema>

export const PreislistePreisSchema = z.object({
  artikelId:            z.string().guid(),
  artikelBezeichnung:   z.string(),
  /** Sonderpreis brutto in Cent */
  preisBruttoCent:      z.number().int().nonnegative(),
  /** Normaler Artikelpreis brutto in Cent (zum Vergleich) */
  regulaerBruttoCent:   z.number().int(),
  artikelAktiv:         z.boolean(),
})
export type PreislistePreis = z.infer<typeof PreislistePreisSchema>

export const PreislisteDetailSchema = PreislisteSchema.extend({
  preise: z.array(PreislistePreisSchema),
})
export type PreislisteDetail = z.infer<typeof PreislisteDetailSchema>

export const PreislisteInputSchema = z.object({
  name: z.string().trim().min(1, 'Name erforderlich').max(80),
})
export type PreislisteInput = z.infer<typeof PreislisteInputSchema>

export const PreislisteUpdateSchema = z.object({
  name:  z.string().trim().min(1).max(80).optional(),
  aktiv: z.boolean().optional(),
})
export type PreislisteUpdate = z.infer<typeof PreislisteUpdateSchema>

export const PreislistePreiseSetzenSchema = z.object({
  preise: z.array(z.object({
    artikelId:       z.string().guid(),
    preisBruttoCent: z.number().int().nonnegative().max(100_000_000),
  })).min(1, 'Mindestens ein Preis').max(5000),
})
export type PreislistePreiseSetzen = z.infer<typeof PreislistePreiseSetzenSchema>

/** Was die Kasse für einen gewählten Kunden braucht: seine Liste samt allen Preisen (null = keine Preisliste) */
export const PreislisteFuerKundeSchema = z.object({
  preislisteId: z.string().guid(),
  name:         z.string(),
  preise:       z.array(z.object({ artikelId: z.string().guid(), preisBruttoCent: z.number().int().nonnegative() })),
}).nullable()
export type PreislisteFuerKunde = z.infer<typeof PreislisteFuerKundeSchema>
