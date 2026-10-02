import { z } from 'zod'
import { istKalenderDatum } from '../geschaeftstag.js'

// ---------------------------------------------------------------------------
// Geschäftstag — Tagesbeginn je Mandant, gültig ab einem Stichtag
// (Rechenkern: ../geschaeftstag.ts)
// ---------------------------------------------------------------------------

/** Wiener Kalendertag YYYY-MM-DD (echtes Datum, kein 2026-02-30). */
export const TagesbeginnDatumSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (JJJJ-MM-TT)')
  .refine(istKalenderDatum, 'Ungültiges Datum')

/** Uhrzeit des Tagesbeginns HH:MM, 00:00 bis 23:59. */
export const TagesbeginnUhrzeitSchema = z.string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM (00:00 bis 23:59)')

/** Ein Eintrag der Historie: ab `gueltigAb` beginnt der Geschäftstag um `beginn`. */
export const TagesbeginnEintragSchema = z.object({
  gueltigAb: TagesbeginnDatumSchema,
  beginn:    TagesbeginnUhrzeitSchema,
})

/** Eingabe zum Anlegen eines neuen Tagesbeginns (der Mandant kommt immer aus dem Login). */
export const TagesbeginnInputSchema = TagesbeginnEintragSchema
export type TagesbeginnInput = z.infer<typeof TagesbeginnInputSchema>

/** Gespeicherter Eintrag mit Kennung (zum Zurücknehmen eines geplanten Wechsels). */
export const TagesbeginnZeileSchema = TagesbeginnEintragSchema.extend({
  id:        z.string().uuid(),
  createdAt: z.string(),
})
export type TagesbeginnZeile = z.infer<typeof TagesbeginnZeileSchema>

/** Stand der Einstellung samt Vorschau „heute". */
export const TagesbeginnStandSchema = z.object({
  /** Gesamte Historie inkl. geplanter Wechsel, aufsteigend nach gueltigAb */
  eintraege: z.array(TagesbeginnZeileSchema),
  heute: z.object({
    /** Wiener Kalendertag jetzt (YYYY-MM-DD) */
    kalendertag:   z.string(),
    /** Aktueller Geschäftstag (YYYY-MM-DD) — um 02:00 nachts bei Tagesbeginn 06:00 der Vortag */
    geschaeftstag: z.string(),
    /** Heute geltender Tagesbeginn (HH:MM) */
    beginn:        z.string(),
    /** Grenzen des aktuellen Geschäftstags als ISO-Zeitpunkte: [von, bis) */
    von:           z.string(),
    bis:           z.string(),
  }),
})
export type TagesbeginnStand = z.infer<typeof TagesbeginnStandSchema>
