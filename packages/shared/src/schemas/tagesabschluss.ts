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
  /** YYYY-MM-DD – Geschäftstag (Standard: Wiener Kalendertag; mit verschobenem Tagesbeginn der Tag, der dort beginnt) */
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

  /**
   * Grenzen des Geschäftstags als ISO-Zeitpunkte [von, bis). NUR gesetzt, wenn der
   * Tag nicht von 00:00 bis 00:00 Wiener Zeit läuft (Tagesbeginn ≠ 00:00) — ohne
   * verschobenen Tagesbeginn bleibt die Antwort so, wie sie immer war.
   */
  zeitraum: z.object({ von: z.string(), bis: z.string() }).optional(),
})

export type Tagesabschluss = z.infer<typeof TagesabschlussSchema>

export const TagesabschlussQuerySchema = z.object({
  kasseId: z.string().uuid(),
  /** YYYY-MM-DD */
  datum:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datumsformat (YYYY-MM-DD)'),
})

export type TagesabschlussQuery = z.infer<typeof TagesabschlussQuerySchema>

/** Z-Bon drucken: optional auf einem Drucker der Bibliothek statt dem Kassen-Bondrucker. */
export const TagesabschlussDruckenSchema = TagesabschlussQuerySchema.extend({
  druckerId: z.string().uuid().optional(),
})
export type TagesabschlussDrucken = z.infer<typeof TagesabschlussDruckenSchema>
