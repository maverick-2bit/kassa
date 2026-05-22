import { z } from 'zod'

// ---------------------------------------------------------------------------
// MwSt-Zeile im Tagesabschluss
// ---------------------------------------------------------------------------

export const MwStZeileSchema = z.object({
  /** Steuersatz-Schlüssel (normal | ermaessigt1 | ermaessigt2 | null | besonders) */
  satzKey:    z.string(),
  /** Anzeige-Label, z. B. "20% Normal" */
  label:      z.string(),
  /** Brutto-Umsatz für diesen Satz (inkl. Storno-Korrekturen), in Cent */
  bruttoCent: z.number().int(),
  /** Netto-Anteil in Cent */
  nettoCent:  z.number().int(),
  /** USt-Anteil in Cent */
  ustCent:    z.number().int(),
})

export type MwStZeile = z.infer<typeof MwStZeileSchema>

// ---------------------------------------------------------------------------
// Tagesabschluss (Z-Bon)
// ---------------------------------------------------------------------------

export const TagesabschlussSchema = z.object({
  /** YYYY-MM-DD – Stichtag in Wiener Ortszeit */
  datum:                   z.string(),
  kasseId:                 z.string().uuid(),

  /** Anzahl Barzahlungsbelege (inkl. durch Storno annullierter) */
  anzahlBarzahlungsbelege: z.number().int(),
  /** Anzahl Stornobelege */
  anzahlStornobelege:      z.number().int(),

  /** Netto-Umsatz nach Abzug der Stornos (Barzahlungsbelege + Stornobelege summiert) */
  nettoUmsatzCent: z.number().int(),
  /** davon bar bezahlt */
  barCent:         z.number().int(),
  /** davon Karte */
  karteCent:       z.number().int(),
  /** davon sonstig */
  sonstigCent:     z.number().int(),

  /** USt-Aufteilung (nur Sätze mit Umsatz ≠ 0) */
  mwst: z.array(MwStZeileSchema),
})

export type Tagesabschluss = z.infer<typeof TagesabschlussSchema>

export const TagesabschlussQuerySchema = z.object({
  kasseId: z.string().uuid(),
  /** YYYY-MM-DD */
  datum:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datumsformat (YYYY-MM-DD)'),
})

export type TagesabschlussQuery = z.infer<typeof TagesabschlussQuerySchema>
