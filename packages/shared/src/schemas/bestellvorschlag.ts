import { z } from 'zod'

// ---------------------------------------------------------------------------
// Bestellvorschlag — aus dem Verbrauch der letzten Tage
// ---------------------------------------------------------------------------
//
// Vorschlag = Bedarf für die Reichweite + Mindestbestand − Lagerstand − unterwegs (bestellt, noch nicht geliefert)
//   Bedarf   = Verbrauch je Tag × Reichweite (aufgerundet)
//   Verbrauch = Verkäufe − Stornos im Zeitraum, dazu der Bedarf an Bestandteilen über die Rezepturen
// Der Mindestbestand ist der Sicherheitsbestand: Er bleibt nach der Reichweite übrig.

export const BESTELLVORSCHLAG_STANDARD_TAGE = 14

export const BestellvorschlagQuerySchema = z.object({
  /** Rückblick: Verbrauch der letzten n Tage */
  tage:       z.coerce.number().int().min(1).max(365).default(BESTELLVORSCHLAG_STANDARD_TAGE),
  /** Für wie viele Tage soll die Bestellung reichen? Standard: so lange wie der Rückblick */
  reichweite: z.coerce.number().int().min(1).max(365).optional(),
})
export type BestellvorschlagQuery = z.infer<typeof BestellvorschlagQuerySchema>

export const BestellvorschlagZeileSchema = z.object({
  artikelId:                z.string(),
  bezeichnung:              z.string(),
  artikelnummer:            z.string().nullable(),
  lieferantId:              z.string().nullable(),
  lieferantenArtikelnummer: z.string().nullable(),
  einkaufspreisCent:        z.number().int().nullable(),
  bestand:                  z.number(),
  /** Bestellt (gesendet/teilgeliefert), noch nicht geliefert */
  unterwegs:                z.number(),
  mindestbestand:           z.number().nullable(),
  /** Verbrauch im Zeitraum (Stück) */
  verbrauch:                z.number(),
  /** Ø Verbrauch je Tag */
  verbrauchProTag:          z.number(),
  /** Erwartete Reichweite des Lagerstands allein (Tage); null = kein Verbrauch */
  reichtTageBestand:        z.number().nullable(),
  /** Reicht der Bestand samt unterwegs noch so viele Tage? null = kein Verbrauch */
  reichtTage:               z.number().nullable(),
  /** Bedarf für die Reichweite (Stück) */
  bedarf:                   z.number(),
  /** Vorgeschlagene Bestellmenge (Stück, ≥ 0) */
  vorschlag:                z.number(),
})
export type BestellvorschlagZeile = z.infer<typeof BestellvorschlagZeileSchema>

export const BestellvorschlagSchema = z.object({
  tage:       z.number(),
  reichweite: z.number(),
  /** Beginn des Rückblicks (ISO) */
  seit:       z.string(),
  zeilen:     z.array(BestellvorschlagZeileSchema),
})
export type Bestellvorschlag = z.infer<typeof BestellvorschlagSchema>

/** Die reine Rechnung einer Zeile — gemeinsam für Server und Tests */
export function berechneVorschlag(e: {
  bestand: number; unterwegs: number; mindestbestand: number | null; verbrauch: number; tage: number; reichweite: number
}): Pick<BestellvorschlagZeile, 'verbrauchProTag' | 'reichtTageBestand' | 'reichtTage' | 'bedarf' | 'vorschlag'> {
  const verbrauch = Math.max(0, e.verbrauch)
  const verbrauchProTag = verbrauch / e.tage
  const vorhanden = Math.max(0, e.bestand) + Math.max(0, e.unterwegs)
  const bedarf = Math.max(0, Math.ceil(verbrauchProTag * e.reichweite - 1e-9))
  const vorschlag = Math.max(0, bedarf + Math.max(0, e.mindestbestand ?? 0) - vorhanden)
  const reicht = (menge: number) => verbrauchProTag > 0 ? Math.round((menge / verbrauchProTag) * 10) / 10 : null
  return {
    verbrauchProTag:   Math.round(verbrauchProTag * 100) / 100,
    reichtTageBestand: reicht(Math.max(0, e.bestand)),
    reichtTage:        reicht(vorhanden),
    bedarf,
    vorschlag,
  }
}
