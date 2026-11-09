import { z } from 'zod'

/**
 * Einkaufsbestellung — Bestellung der Kassa-Betreiber BEI einem Lieferanten
 * (nicht zu verwechseln mit Lieferbestellungen/Gast-Bestellungen: das sind Bestellungen von Kunden).
 *
 * Status: entwurf → gesendet → (teilgeliefert →) erledigt;  storniert aus entwurf/gesendet.
 * `teilgeliefert` setzt erst der Wareneingang gegen die Bestellung (Folgeschritt) — die Positionen tragen
 * dafür schon `gelieferteMenge`.
 */

export const EINKAUF_BESTELLSTATUS = ['entwurf', 'gesendet', 'teilgeliefert', 'erledigt', 'storniert'] as const
export const EinkaufBestellstatusSchema = z.enum(EINKAUF_BESTELLSTATUS)
export type EinkaufBestellstatus = z.infer<typeof EinkaufBestellstatusSchema>

export const EINKAUF_BESTELLSTATUS_LABELS: Record<EinkaufBestellstatus, string> = {
  entwurf:       'Entwurf',
  gesendet:      'Gesendet',
  teilgeliefert: 'Teilweise geliefert',
  erledigt:      'Erledigt',
  storniert:     'Storniert',
}

export const EinkaufBestellpositionSchema = z.object({
  id:                       z.string().guid(),
  position:                 z.number().int().positive(),
  artikelId:                z.string().guid().nullable(),
  bezeichnung:              z.string(),
  lieferantenArtikelnummer: z.string().nullable(),
  menge:                    z.number().int().positive(),
  /** Einkaufspreis netto je Stück in Cent; null = unbekannt */
  einkaufspreisCent:        z.number().int().nonnegative().nullable(),
  gelieferteMenge:          z.number().int().nonnegative(),
})
export type EinkaufBestellposition = z.infer<typeof EinkaufBestellpositionSchema>

export const EinkaufBestellungSchema = z.object({
  id:               z.string().guid(),
  mandantId:        z.string().guid(),
  nummer:           z.string(),
  lieferantId:      z.string().guid(),
  lieferantName:    z.string(),
  status:           EinkaufBestellstatusSchema,
  bemerkung:        z.string().nullable(),
  /** Gewünschter Liefertermin (YYYY-MM-DD) */
  liefertermin:     z.string().nullable(),
  gesendetAm:       z.string().nullable(),
  gesendetAn:       z.string().nullable(),
  positionen:       z.array(EinkaufBestellpositionSchema),
  /** Summe netto in Cent über alle Positionen mit bekanntem Preis */
  summeNettoCent:   z.number().int(),
  /** true, wenn mindestens eine Position keinen Preis hat (Summe unvollständig) */
  summeUnvollstaendig: z.boolean(),
  createdAt:        z.string(),
  updatedAt:        z.string(),
})
export type EinkaufBestellung = z.infer<typeof EinkaufBestellungSchema>

/** Kurzform für die Liste (ohne Positionen) */
export type EinkaufBestellungKurz = Omit<EinkaufBestellung, 'positionen'> & { anzahlPositionen: number }

export const EinkaufBestellpositionInputSchema = z.object({
  artikelId:                z.string().guid().optional().nullable(),
  bezeichnung:              z.string().trim().min(1, 'Bezeichnung erforderlich').max(200),
  lieferantenArtikelnummer: z.string().trim().max(60).optional().nullable(),
  menge:                    z.number().int().positive('Menge muss größer 0 sein').max(100000),
  einkaufspreisCent:        z.number().int().nonnegative().optional().nullable(),
})
export type EinkaufBestellpositionInput = z.infer<typeof EinkaufBestellpositionInputSchema>

const Termin = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')

export const EinkaufBestellungInputSchema = z.object({
  lieferantId:  z.string().guid(),
  bemerkung:    z.string().trim().max(2000).optional().nullable(),
  liefertermin: Termin.optional().nullable(),
  positionen:   z.array(EinkaufBestellpositionInputSchema).min(1, 'Mindestens eine Position').max(500),
})
export type EinkaufBestellungInput = z.infer<typeof EinkaufBestellungInputSchema>

/** Bearbeiten nur im Entwurf; Positionen werden vollständig ersetzt. Der Lieferant bleibt fix. */
export const EinkaufBestellungUpdateSchema = z.object({
  bemerkung:    z.string().trim().max(2000).nullable().optional(),
  liefertermin: Termin.nullable().optional(),
  positionen:   z.array(EinkaufBestellpositionInputSchema).min(1, 'Mindestens eine Position').max(500).optional(),
})
export type EinkaufBestellungUpdate = z.infer<typeof EinkaufBestellungUpdateSchema>

export const EinkaufBestellungEmailSchema = z.object({
  /** Leer = E-Mail-Adresse des Lieferanten */
  empfaenger: z.string().trim().email().max(200).optional(),
})
export type EinkaufBestellungEmail = z.infer<typeof EinkaufBestellungEmailSchema>

/** Erlaubte Statuswechsel (ohne `teilgeliefert`, das setzt der Wareneingang). */
export const EINKAUF_BESTELLSTATUS_UEBERGAENGE: Record<EinkaufBestellstatus, readonly EinkaufBestellstatus[]> = {
  entwurf:       ['gesendet', 'storniert'],
  gesendet:      ['erledigt', 'storniert'],
  teilgeliefert: ['erledigt'],
  erledigt:      [],
  storniert:     [],
}

export function summeBestellung(
  positionen: { menge: number; einkaufspreisCent: number | null }[],
): { summeNettoCent: number; summeUnvollstaendig: boolean } {
  let summe = 0
  let fehlt = false
  for (const p of positionen) {
    if (p.einkaufspreisCent == null) fehlt = true
    else summe += p.menge * p.einkaufspreisCent
  }
  return { summeNettoCent: summe, summeUnvollstaendig: fehlt }
}
