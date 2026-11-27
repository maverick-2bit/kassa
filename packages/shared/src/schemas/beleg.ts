import { z } from 'zod'
import { MwStSatzSchema } from './artikel.js'
import { KundeInputSchema, KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Beleg-Position (im Bon enthaltene Zeile)
// ---------------------------------------------------------------------------

export const BelegPositionSchema = z.object({
  bezeichnung:        z.string(),
  menge:              z.number().positive(),
  einzelpreisBreutto: z.number().int(),
  mwstSatz:           MwStSatzSchema,
  /** Zugewiesene Seriennummern (für den Aufdruck auf der Rechnung) */
  seriennummern:      z.array(z.string()).optional(),
  /** EAN des Artikels zum Verkaufszeitpunkt (Aufdruck unter der Position) */
  ean:                z.string().optional(),
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
  artikelId:              z.string().guid(),
  menge:                  z.number().positive('Menge muss positiv sein'),
  /** Preis-Override (Modifikatoren oder Rabatt; 0 = Artikel gratis; negativ bei Pfand-Rückgabe) */
  einzelpreisBreuttoCent: z.number().int().optional(),
  /** Bezeichnungs-Zusatz, z. B. "(groß, Ketchup)" */
  bezeichnungZusatz:      z.string().max(200).optional(),
  /** Gewählte Seriennummern aus dem Pool (bei serialisierten Artikeln) */
  seriennummern:          z.array(z.string()).optional(),
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
  kasseId:    z.string().guid(),
  positionen: z.array(BelegInputPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  zahlung: z.object({
    // Negativ nur bei einem Beleg unter 0 (Retoure, Pfand-Rückgabe) — der Service prüft das Vorzeichen
    barCent:      z.number().int(),
    karteCent:    z.number().int(),
    sonstigeCent: z.number().int(),
  }),
  rabatt:     RabattInputSchema.optional(),
  /** Bestehenden Kunden zuordnen */
  kundeId:    z.string().guid().optional(),
  /** Neuen Kunden anlegen und direkt verknüpfen */
  neuerKunde: KundeInputSchema.optional(),
  /** Auto-Druck unterdrücken (für „Alternativdruck": Ausgabe wird im Dialog gewählt).
   *  Reines Transport-Flag, wird nicht persistiert. */
  keinAutodruck: z.boolean().optional(),
  /**
   * PIN eines Freigabeberechtigten — nur nötig, wenn der Rabatt über der
   * eingestellten Freigabeschwelle liegt (Einstellungen → Freigaben).
   */
  freigabePin: z.string().trim().min(4).max(12).optional(),
})
export type BarzahlungsbelegInput = z.infer<typeof BarzahlungsbelegInputSchema>

// ---------------------------------------------------------------------------
// Stornobeleg — Komplett-Storno eines vorherigen Belegs
// ---------------------------------------------------------------------------

export const StornobelegInputSchema = z.object({
  kasseId:        z.string().guid(),
  verweisBelegId: z.string().guid(),
  /** Optional: Grund (für interne Dokumentation, nicht im Bon-QR-Code) */
  grund:          z.string().trim().max(200).optional(),
  /**
   * PIN eines Freigabeberechtigten — nur nötig, wenn der Belegbetrag über der
   * eingestellten Freigabeschwelle liegt (Einstellungen → Freigaben).
   */
  freigabePin:    z.string().trim().min(4).max(12).optional(),
  /**
   * Welche Positionen des Originalbelegs zurück ins Lager gehen (Indizes). Fehlt die Angabe, gilt die Vorgabe der
   * Artikel (automatisch: ohne Rezeptur ja, mit Rezeptur nein). Beim Zurückholen schickt die Kasse alle mit.
   */
  lagerZurueck:   z.array(z.number().int().min(0).max(999)).max(1000).optional(),
})
export type StornobelegInput = z.infer<typeof StornobelegInputSchema>

/** Vorschau für den Storno-Dialog: je Position, ob sie zurück ins Lager kann und was vorgeschlagen ist */
export const StornoLagerPositionSchema = z.object({
  index:       z.number().int(),
  bezeichnung: z.string(),
  menge:       z.number(),
  artikelId:   z.string().nullable(),
  wirkung:     z.boolean(),
  vorschlag:   z.boolean(),
  grund:       z.string(),
})
export type StornoLagerPosition = z.infer<typeof StornoLagerPositionSchema>

// ---------------------------------------------------------------------------
// Nullbeleg — Test-/Kontrollbeleg ohne Umsatz
// ---------------------------------------------------------------------------

export const NullbelegInputSchema = z.object({
  kasseId: z.string().guid(),
})
export type NullbelegInput = z.infer<typeof NullbelegInputSchema>

// ---------------------------------------------------------------------------
// Monatsbeleg — Monatsabschluss (RKSV-Pflicht)
// ---------------------------------------------------------------------------

export const MonatsbelegInputSchema = z.object({
  kasseId: z.string().guid(),
})
export type MonatsbelegInput = z.infer<typeof MonatsbelegInputSchema>

// ---------------------------------------------------------------------------
// Jahresbeleg — Jahresabschluss (RKSV-Pflicht)
// ---------------------------------------------------------------------------

export const JahresbelegInputSchema = z.object({
  kasseId: z.string().guid(),
})
export type JahresbelegInput = z.infer<typeof JahresbelegInputSchema>

// ---------------------------------------------------------------------------
// Beleg-Response
// ---------------------------------------------------------------------------

export const BelegResponseSchema = z.object({
  id:           z.string().guid(),
  belegNummer:  z.number().int(),
  belegDatum:   z.string(),
  belegTyp:     z.string(),

  betraege: z.object({
    normal:      z.number().int(),
    ermaessigt1: z.number().int(),
    ermaessigt2: z.number().int(),
    /** 4,9 % — im QR-Code mit `besonders` zusammengefasst, hier getrennt (Default: Belege vor dem 4,9-%-Satz) */
    ermaessigt3: z.number().int().default(0),
    null:        z.number().int(),
    besonders:   z.number().int(),
  }),

  summeBarCent:      z.number().int(),
  summeKarteCent:    z.number().int(),
  summeSonstigeCent: z.number().int(),
  gesamtbetragCent:  z.number().int(),

  positionen: z.array(BelegPositionSchema),

  /** Nur bei Stornobeleg: ID des Original-Belegs */
  verweisBelegId: z.string().guid().optional(),

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

// ---------------------------------------------------------------------------
// Belegliste einer Kasse mit Filter + Paging (Auswertung → Belege)
// ---------------------------------------------------------------------------

const DatumSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')

/**
 * Suche in den Belegen EINER Kasse des Mandanten. Die Kasse ist frei wählbar
 * (Barkasse, Kellner-Geräte …), die Belege bleiben aber je Kasse getrennt —
 * jede Kasse hat ihre eigene RKSV-Kette und Nummernfolge.
 */
export const BelegSucheQuerySchema = z.object({
  kasseId: z.string().guid(),
  /** Wiener Kalendertag, inklusive */
  von:     DatumSchema.optional(),
  /** Wiener Kalendertag, inklusive */
  bis:     DatumSchema.optional(),
  /** Belegnummer, Betrag (12,50) oder Kundenname */
  suche:   z.string().trim().max(100).optional(),
  kundeId: z.string().guid().optional(),
  /** Komma-getrennte Belegtypen, z. B. „Monatsbeleg,Jahresbeleg" */
  typen:   z.string().max(200).optional(),
  limit:   z.coerce.number().int().min(1).max(200).default(50),
  offset:  z.coerce.number().int().min(0).default(0),
})
export type BelegSucheQuery = z.input<typeof BelegSucheQuerySchema>

export const BelegListeEintragSchema = BelegResponseSchema.extend({
  /** Gesetzt, wenn ein Stornobeleg auf diesen Beleg verweist */
  storniertDurch: z.object({ id: z.string().guid(), belegNummer: z.number().int() }).optional(),
})
export type BelegListeEintrag = z.infer<typeof BelegListeEintragSchema>

export interface BelegSeite {
  belege: BelegListeEintrag[]
  /** Anzahl aller Treffer (für das Paging) */
  gesamt: number
}
