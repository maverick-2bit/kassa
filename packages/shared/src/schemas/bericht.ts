import { z } from 'zod'
import { MwStZeileSchema } from './tagesabschluss.js'

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export const BerichtGruppierungSchema = z.enum(['tag', 'woche', 'monat'])
export type BerichtGruppierung = z.infer<typeof BerichtGruppierungSchema>

export const BerichtFilterSchema = z.object({
  /** Kassen-IDs; leer = alle zugänglichen Kassen des Mandanten */
  kasseIds:          z.array(z.string().uuid()).default([]),
  /** Startdatum YYYY-MM-DD (Wiener Ortszeit) */
  von:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
  /** Enddatum YYYY-MM-DD (Wiener Ortszeit, inklusiv) */
  bis:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
  /** Nur Belege mit Sonstig-Zahlung > 0 (Zielrechnungen) anzeigen */
  nurZielrechnungen: z.boolean().default(false),
  /** Zeitliche Gruppierung der Tabelle */
  gruppierung:       BerichtGruppierungSchema.default('tag'),
})
export type BerichtFilter = z.infer<typeof BerichtFilterSchema>

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

export const BerichtZeileSchema = z.object({
  /** Periodenbezeichnung: YYYY-MM-DD (Tag), YYYY-KWww (Woche), YYYY-MM (Monat) */
  periode:      z.string(),
  anzahlBelege: z.number().int(),
  anzahlStornos: z.number().int(),
  umsatzCent:   z.number().int(),
  barCent:      z.number().int(),
  karteCent:    z.number().int(),
  sonstigCent:  z.number().int(),
})
export type BerichtZeile = z.infer<typeof BerichtZeileSchema>

export const BerichtGesamtSchema = z.object({
  anzahlBelege:  z.number().int(),
  anzahlStornos: z.number().int(),
  umsatzCent:    z.number().int(),
  barCent:       z.number().int(),
  karteCent:     z.number().int(),
  sonstigCent:   z.number().int(),
  mwst:          z.array(MwStZeileSchema),
})
export type BerichtGesamt = z.infer<typeof BerichtGesamtSchema>

export const BerichtResponseSchema = z.object({
  von:         z.string(),
  bis:         z.string(),
  kasseIds:    z.array(z.string().uuid()),
  zeilen:      z.array(BerichtZeileSchema),
  gesamt:      BerichtGesamtSchema,
})
export type BerichtResponse = z.infer<typeof BerichtResponseSchema>

// ---------------------------------------------------------------------------
// Artikel-Umsatzbericht
// ---------------------------------------------------------------------------

export const ArtikelBerichtFilterSchema = z.object({
  kasseIds: z.array(z.string().uuid()).default([]),
  von:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
  bis:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
  /** Maximale Anzahl zurückgegebener Artikel (Standard: 200) */
  limit:    z.coerce.number().int().min(1).max(1000).default(200),
})
export type ArtikelBerichtFilter = z.infer<typeof ArtikelBerichtFilterSchema>

export const ArtikelBerichtZeileSchema = z.object({
  bezeichnung:  z.string(),
  mengeSumme:   z.number().int(),
  umsatzCent:   z.number().int(),
})
export type ArtikelBerichtZeile = z.infer<typeof ArtikelBerichtZeileSchema>

export const ArtikelBerichtResponseSchema = z.object({
  von:      z.string(),
  bis:      z.string(),
  kasseIds: z.array(z.string().uuid()),
  zeilen:   z.array(ArtikelBerichtZeileSchema),
})
export type ArtikelBerichtResponse = z.infer<typeof ArtikelBerichtResponseSchema>

// ---------------------------------------------------------------------------
// Warengruppen-Bericht
// ---------------------------------------------------------------------------

export const WarengruppeBerichtFilterSchema = ArtikelBerichtFilterSchema

export const WarengruppeBerichtZeileSchema = z.object({
  kategorieName: z.string(),
  mengeSumme:    z.number().int(),
  umsatzCent:    z.number().int(),
})
export type WarengruppeBerichtZeile = z.infer<typeof WarengruppeBerichtZeileSchema>

export const WarengruppeBerichtResponseSchema = z.object({
  von:      z.string(),
  bis:      z.string(),
  kasseIds: z.array(z.string().uuid()),
  zeilen:   z.array(WarengruppeBerichtZeileSchema),
})
export type WarengruppeBerichtResponse = z.infer<typeof WarengruppeBerichtResponseSchema>

// ---------------------------------------------------------------------------
// Stunden-Bericht (Umsatz nach Tageszeit)
// ---------------------------------------------------------------------------

export const StundenBerichtFilterSchema = z.object({
  kasseIds: z.array(z.string().uuid()).default([]),
  von:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
  bis:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum (YYYY-MM-DD)'),
})
export type StundenBerichtFilter = z.infer<typeof StundenBerichtFilterSchema>

export const StundenBerichtZeileSchema = z.object({
  stunde:        z.number().int().min(0).max(23),
  anzahlBelege:  z.number().int(),
  anzahlStornos: z.number().int(),
  umsatzCent:    z.number().int(),
  barCent:       z.number().int(),
  karteCent:     z.number().int(),
  sonstigCent:   z.number().int(),
})
export type StundenBerichtZeile = z.infer<typeof StundenBerichtZeileSchema>

export const StundenBerichtResponseSchema = z.object({
  von:      z.string(),
  bis:      z.string(),
  kasseIds: z.array(z.string().uuid()),
  /** Immer 24 Einträge (Stunde 0–23), Stunden ohne Umsatz mit Nullwerten */
  zeilen:   z.array(StundenBerichtZeileSchema),
  gesamt:   BerichtGesamtSchema,
})
export type StundenBerichtResponse = z.infer<typeof StundenBerichtResponseSchema>
