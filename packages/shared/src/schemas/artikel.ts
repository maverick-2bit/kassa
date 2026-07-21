import { z } from 'zod'
import { StationSchema } from './station.js'

/** Österreichische MwSt-Sätze gemäß RKSV */
export const MwStSatzSchema = z.enum(['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders'])
export type MwStSatz = z.infer<typeof MwStSatzSchema>

export const MWST_LABELS: Record<MwStSatz, string> = {
  normal:      '20 % (Normal)',
  ermaessigt1: '10 % (Ermäßigt)',
  ermaessigt2: '13 % (Ermäßigt 2)',
  null:        '0 %',
  besonders:   '19 % (Sondersteuersatz)',
}

// ---------------------------------------------------------------------------
// Stückliste / Rezept — ein Bestandteil (Rohstoff-Artikel) + Menge
// ---------------------------------------------------------------------------

/** Bestandteil in der Response (mit Bezeichnung zur Anzeige). */
export const ArtikelBestandteilSchema = z.object({
  bestandteilArtikelId: z.string().uuid(),
  bezeichnung:          z.string(),
  menge:                z.number().int().positive(),
})
export type ArtikelBestandteil = z.infer<typeof ArtikelBestandteilSchema>

/** Bestandteil im Input/Update (ohne Bezeichnung — wird serverseitig aufgelöst). */
export const ArtikelBestandteilInputSchema = z.object({
  bestandteilArtikelId: z.string().uuid(),
  menge:                z.number().int().positive('Menge muss positiv sein'),
})

// ---------------------------------------------------------------------------
// Artikel
// ---------------------------------------------------------------------------

export const ArtikelSchema = z.object({
  id:                   z.string().uuid(),
  mandantId:            z.string().uuid(),
  bezeichnung:          z.string(),
  preisBruttoCent:      z.number().int(),
  mwstSatz:             MwStSatzSchema,
  artikelnummer:        z.string().nullable(),
  station:              StationSchema.nullable(),
  kategorieId:          z.string().uuid().nullable(),
  aktiv:                z.boolean(),
  lagerstandAktiv:      z.boolean(),
  lagerstandMenge:      z.number().int().nonnegative().nullable(),
  mindestbestand:       z.number().int().nonnegative().nullable(),
  /** Seriennummern-Verwaltung: Bestand = Anzahl freier Seriennummern im Pool */
  seriennummernAktiv:   z.boolean(),
  istFavorit:           z.boolean(),
  reihenfolge:          z.number().int(),
  favoritenReihenfolge: z.number().int(),
  bonierdruckerId:      z.string().uuid().nullable(),
  /** Bonierbon auch beim direkten „Bon erstellen" drucken (sonst nur bei Tischbuchung) */
  bonierBeiDirektverkauf: z.boolean(),
  /** Rohstoff/Bestandteil: nur Lager, nicht direkt verkäuflich */
  istBestandteil:       z.boolean(),
  /** Rezept: Bestandteile dieses Verkaufsartikels (leer = kein Rezept) */
  bestandteile:         z.array(ArtikelBestandteilSchema).default([]),
  /** Abgeleitete Verfügbarkeit aus dem Rezept (min über Bestandteile); null = kein Rezept */
  verfuegbareMenge:     z.number().int().nonnegative().nullable().optional(),
  lieferantId:          z.string().uuid().nullable(),
  /** SB-Terminal-Sichtbarkeit: null = erbt von der Kategorie, true/false = Override */
  terminalSichtbar:     z.boolean().nullable(),
  /** Artikelbild als Data-URL (client-seitig auf max. 200×200 px / JPEG komprimiert) */
  bild:                 z.string().nullable().optional(),
  createdAt:            z.string(),
  updatedAt:            z.string(),
})
export type Artikel = z.infer<typeof ArtikelSchema>

export const ArtikelInputSchema = z.object({
  mandantId:       z.string().uuid(),
  bezeichnung:     z.string().trim().min(1, 'Bezeichnung erforderlich').max(200),
  preisBruttoCent: z.number().int().nonnegative('Preis darf nicht negativ sein'),
  mwstSatz:        MwStSatzSchema,
  // artikelnummer wird serverseitig automatisch generiert – nie vom Client gesetzt
  station:         StationSchema.optional().nullable(),
  kategorieId:     z.string().uuid().optional().nullable(),
  lagerstandAktiv: z.boolean().default(false),
  lagerstandMenge: z.number().int().nonnegative().nullable().default(null),
  mindestbestand:  z.number().int().nonnegative().nullable().default(null),
  seriennummernAktiv: z.boolean().default(false),
  istFavorit:      z.boolean().default(false),
  bonierdruckerId: z.string().uuid().optional().nullable(),
  bonierBeiDirektverkauf: z.boolean().default(false),
  istBestandteil:  z.boolean().default(false),
  bestandteile:    z.array(ArtikelBestandteilInputSchema).default([]),
  lieferantId:     z.string().uuid().optional().nullable(),
  terminalSichtbar: z.boolean().nullable().default(null),
  bild:            z.string().nullable().optional(),
})
export type ArtikelInput = z.infer<typeof ArtikelInputSchema>

export const ArtikelUpdateSchema = z.object({
  bezeichnung:          z.string().trim().min(1).max(200).optional(),
  preisBruttoCent:      z.number().int().nonnegative().optional(),
  mwstSatz:             MwStSatzSchema.optional(),
  station:              StationSchema.optional().nullable(),
  kategorieId:          z.string().uuid().optional().nullable(),
  aktiv:                z.boolean().optional(),
  lagerstandAktiv:      z.boolean().optional(),
  lagerstandMenge:      z.number().int().nonnegative().nullable().optional(),
  mindestbestand:       z.number().int().nonnegative().nullable().optional(),
  seriennummernAktiv:   z.boolean().optional(),
  istFavorit:           z.boolean().optional(),
  reihenfolge:          z.number().int().nonnegative().optional(),
  favoritenReihenfolge: z.number().int().nonnegative().optional(),
  bonierdruckerId:      z.string().uuid().nullable().optional(),
  bonierBeiDirektverkauf: z.boolean().optional(),
  istBestandteil:       z.boolean().optional(),
  bestandteile:         z.array(ArtikelBestandteilInputSchema).optional(),
  lieferantId:          z.string().uuid().nullable().optional(),
  terminalSichtbar:     z.boolean().nullable().optional(),
  bild:                 z.string().nullable().optional(),
})
export type ArtikelUpdate = z.infer<typeof ArtikelUpdateSchema>
