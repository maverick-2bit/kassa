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

// ---------------------------------------------------------------------------
// Bestellung per Sprache: Text rein, Vorschläge raus
//
// Die Vorschläge sind KEINE Buchung. Die Kellner-App übernimmt sie nach Bestätigung in den
// normalen Korb — Bonierung, Preise und RKSV laufen unverändert darüber.
// ---------------------------------------------------------------------------

/** Obergrenze der Textlänge einer Äußerung (eine Bestellung, kein Gespräch). */
export const SPRACHE_TEXT_MAX = 1000

export const SpracheBestellungInputSchema = z.object({
  /** Das Gesagte als Text (Ergebnis der Spracherkennung). */
  text: z.string().trim().min(1).max(SPRACHE_TEXT_MAX),
})
export type SpracheBestellungInput = z.infer<typeof SpracheBestellungInputSchema>

/**
 * sicher    eindeutig erkannt
 * pruefen   erkannt, aber unsicher/mehrdeutig/mit unklarer Option — Kellner bestätigt
 * unbekannt kein Artikel gefunden
 */
export const SprachVorschlagStatusSchema = z.enum(['sicher', 'pruefen', 'unbekannt'])
export type SprachVorschlagStatus = z.infer<typeof SprachVorschlagStatusSchema>

export const SprachVorschlagSchema = z.object({
  menge:     z.number().int().min(1).max(99),
  /** Das Gesagte (normalisiert), für Anzeige und Fehlersuche */
  text:      z.string(),
  artikel:   z.object({ id: z.string().guid(), bezeichnung: z.string() }).nullable(),
  /** 0..1 */
  konfidenz: z.number(),
  status:    SprachVorschlagStatusSchema,
  alternativen: z.array(z.object({ id: z.string().guid(), bezeichnung: z.string(), konfidenz: z.number() })),
  modifikatoren: z.array(z.object({ id: z.string().guid(), gruppeId: z.string().guid(), name: z.string() })),
  /** Gesagte Optionen, die keinem Modifikator zugeordnet werden konnten ("ohne senf") */
  hinweise:  z.array(z.string()),
})
export type SprachVorschlag = z.infer<typeof SprachVorschlagSchema>

export const SpracheBestellungErgebnisSchema = z.object({
  tisch:       z.string().nullable(),
  platz:       z.string().nullable(),
  vorschlaege: z.array(SprachVorschlagSchema),
  /** Rückmeldung zum Vorlesen im Headset ("Tisch 12: zwei Bier … Richtig?") */
  vorlesetext: z.string(),
})
export type SpracheBestellungErgebnis = z.infer<typeof SpracheBestellungErgebnisSchema>
