import { z } from 'zod'

// ---------------------------------------------------------------------------
// Sprachbestellung (optionales Modul) — Synonyme je Artikel
//
// Synonyme sind die Namen, die Kellner tatsächlich sagen („Seidl", „Krügerl", „Gespritzter"),
// und die Spracherkennung dem Artikel zuordnet. Gepflegt werden sie je Artikel.
// ---------------------------------------------------------------------------

/** Anzahl Synonyme je Artikel (mehr braucht niemand, und der Abgleich bleibt schnell). */
export const SYNONYME_MAX_JE_ARTIKEL = 20

export const SynonymTextSchema = z.string().trim().min(1).max(80)

/** Ein Artikel mit seinen Synonymen. */
export const ArtikelSynonymeSchema = z.object({
  artikelId:   z.string().guid(),
  bezeichnung: z.string(),
  synonyme:    z.array(z.string()),
})
export type ArtikelSynonyme = z.infer<typeof ArtikelSynonymeSchema>

/** Alle Synonyme eines Artikels auf einmal setzen (ersetzt die bisherige Liste). */
export const ArtikelSynonymeSetzenSchema = z.object({
  synonyme: z.array(SynonymTextSchema).max(SYNONYME_MAX_JE_ARTIKEL),
})
export type ArtikelSynonymeSetzen = z.infer<typeof ArtikelSynonymeSetzenSchema>

/**
 * Ein Synonym, das auch einen ANDEREN Artikel meint (gleiche Bezeichnung oder gleiches Synonym).
 * Es wird gespeichert, aber die Spracherkennung muss dann immer nachfragen — deshalb die Warnung.
 */
export const SynonymKonfliktSchema = z.object({
  text:               z.string(),
  artikelId:          z.string().guid(),
  artikelBezeichnung: z.string(),
  art:                z.enum(['bezeichnung', 'synonym']),
})
export type SynonymKonflikt = z.infer<typeof SynonymKonfliktSchema>

export const ArtikelSynonymeErgebnisSchema = z.object({
  artikelId: z.string().guid(),
  /** Gespeicherte Synonyme (bereinigt: ohne Dubletten und ohne die eigene Bezeichnung) */
  synonyme:  z.array(z.string()),
  konflikte: z.array(SynonymKonfliktSchema),
})
export type ArtikelSynonymeErgebnis = z.infer<typeof ArtikelSynonymeErgebnisSchema>
