import { z } from 'zod'
import { MANDANT_MODUL_LABELS, MandantModulSchema } from './mandant.js'
import { PortalMeldungSchema } from './portal.js'

// ---------------------------------------------------------------------------
// Serviceportal — Verwaltungs-API (Betriebe, Boxen, Übersicht, Anmeldung)
//
// Das Portal sieht NUR den technischen Zustand der Boxen (siehe portal.ts). Alles hier beschreibt, was das Portal
// daraus für den Betreiber macht: Flottenübersicht, Bewertung je Box, Verwaltung von Betrieben und Zugangs-Token.
// ---------------------------------------------------------------------------

/** Module, die ein Betrieb gebucht haben kann: die der Kassa plus die Quartals-Datensicherung (Portal-Modul). */
export const PORTAL_MODULE = [...MandantModulSchema.options, 'quartalsSicherung'] as const
export const PortalModulSchema = z.enum(PORTAL_MODULE)
export type PortalModul = z.infer<typeof PortalModulSchema>

export const PORTAL_MODUL_LABELS: Record<PortalModul, string> = {
  ...MANDANT_MODUL_LABELS,
  quartalsSicherung: 'Quartals-Datensicherung',
}

// ---- Bewertung einer Box --------------------------------------------------

/**
 * ok        alles in Ordnung
 * warnung   etwas braucht Aufmerksamkeit (Sicherung veraltet, Drucker weg, Speicher knapp …)
 * kritisch  der Betrieb ist gefährdet (Datenbank, Signatureinheit, Speicher voll …)
 * offline   die Box hat sich zu lange nicht gemeldet
 * neu       noch keine Meldung eingegangen (Box eben angelegt)
 */
export const BoxStatusSchema = z.enum(['ok', 'warnung', 'kritisch', 'offline', 'neu'])
export type BoxStatus = z.infer<typeof BoxStatusSchema>

export const BOX_STATUS_LABELS: Record<BoxStatus, string> = {
  ok:       'In Ordnung',
  warnung:  'Warnung',
  kritisch: 'Kritisch',
  offline:  'Offline',
  neu:      'Noch keine Meldung',
}

export const BoxGrundSchema = z.object({
  stufe: z.enum(['kritisch', 'warnung', 'info']),
  /** Maschinenlesbar, z. B. 'db', 'backup-db', 'drucker' — für Alarme und Filter */
  code:  z.string(),
  text:  z.string(),
})
export type BoxGrund = z.infer<typeof BoxGrundSchema>

export const BoxKurzSchema = z.object({
  id:            z.string().guid(),
  name:          z.string(),
  aktiv:         z.boolean(),
  status:        BoxStatusSchema,
  gruende:       z.array(BoxGrundSchema),
  zuletztGesehen: z.string().nullable(),
  version:       z.string().nullable(),
})
export type BoxKurz = z.infer<typeof BoxKurzSchema>

export const BetriebUebersichtSchema = z.object({
  id:     z.string().guid(),
  name:   z.string(),
  notiz:  z.string().nullable(),
  aktiv:  z.boolean(),
  module: z.array(PortalModulSchema),
  /** Schlechtester Status seiner aktiven Boxen */
  status: BoxStatusSchema,
  boxen:  z.array(BoxKurzSchema),
})
export type BetriebUebersicht = z.infer<typeof BetriebUebersichtSchema>

export const UebersichtSchema = z.object({
  betriebe: z.array(BetriebUebersichtSchema),
  /** Anzahl aktiver Boxen je Status */
  zusammenfassung: z.object({
    boxen:    z.number().int(),
    ok:       z.number().int(),
    warnung:  z.number().int(),
    kritisch: z.number().int(),
    offline:  z.number().int(),
    neu:      z.number().int(),
  }),
})
export type Uebersicht = z.infer<typeof UebersichtSchema>

// ---- Detail einer Box ---------------------------------------------------

export const PortalFehlerSammlungSchema = z.object({
  hash:      z.string(),
  name:      z.string(),
  meldung:   z.string(),
  route:     z.string().nullable(),
  anzahl:    z.number().int(),
  ersterAm:  z.string(),
  letzterAm: z.string(),
})
export type PortalFehlerSammlung = z.infer<typeof PortalFehlerSammlungSchema>

export const BoxDetailSchema = z.object({
  box:         BoxKurzSchema,
  betriebId:   z.string().guid(),
  betriebName: z.string(),
  /** Letzte vier Zeichen des Tokens — damit man Boxen auseinanderhält, ohne das Token zu kennen */
  tokenHinweis: z.string(),
  /** Letzte vollständige Meldung der Box (null = noch keine) */
  meldung:     PortalMeldungSchema.nullable(),
  /** Fehlerberichte, gruppiert, neueste zuerst */
  fehler:      z.array(PortalFehlerSammlungSchema),
})
export type BoxDetail = z.infer<typeof BoxDetailSchema>

// ---- Verwaltung -----------------------------------------------------------

export const BetriebAnlegenSchema = z.object({
  name:  z.string().trim().min(1).max(200),
  notiz: z.string().trim().max(2000).nullable().optional(),
})
export type BetriebAnlegen = z.infer<typeof BetriebAnlegenSchema>

export const BetriebAktualisierenSchema = z.object({
  name:   z.string().trim().min(1).max(200).optional(),
  notiz:  z.string().trim().max(2000).nullable().optional(),
  aktiv:  z.boolean().optional(),
  /** Gebuchte Module (Vermerk — die Box schaltet ihre Module weiterhin selbst) */
  module: z.array(PortalModulSchema).optional(),
})
export type BetriebAktualisieren = z.infer<typeof BetriebAktualisierenSchema>

export const BoxAnlegenSchema = z.object({
  name: z.string().trim().min(1).max(100),
})
export type BoxAnlegen = z.infer<typeof BoxAnlegenSchema>

export const BoxAktualisierenSchema = z.object({
  name:  z.string().trim().min(1).max(100).optional(),
  aktiv: z.boolean().optional(),
})
export type BoxAktualisieren = z.infer<typeof BoxAktualisierenSchema>

/** Antwort beim Anlegen/Erneuern: das Token steht NUR hier — das Portal speichert nur seinen Hash. */
export const BoxMitTokenSchema = z.object({
  box:   BoxKurzSchema,
  token: z.string(),
})
export type BoxMitToken = z.infer<typeof BoxMitTokenSchema>

// ---- Anmeldung (Passwort + TOTP) --------------------------------------------

export const PASSWORT_MIN_LAENGE = 12

export const PortalAnmeldenSchema = z.object({
  email:    z.string().trim().toLowerCase().email().max(200),
  passwort: z.string().min(1).max(200),
  /** 6-stelliger Code der Authenticator-App (erst nach der Einrichtung nötig) */
  code:     z.string().trim().regex(/^\d{6}$/).optional(),
})
export type PortalAnmelden = z.infer<typeof PortalAnmeldenSchema>

export const PortalBenutzerSchema = z.object({
  id:    z.string().guid(),
  email: z.string(),
})
export type PortalBenutzer = z.infer<typeof PortalBenutzerSchema>

/**
 * angemeldet         Passwort und Code stimmen → `token` ist die Sitzung
 * totp_einrichten    Passwort stimmt, aber es gibt noch keine Authenticator-App → `einrichtungsToken` gilt nur für
 *                    die Einrichtung (10 Minuten) und nirgends sonst
 */
export const PortalAnmeldeAntwortSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('angemeldet'), token: z.string(), benutzer: PortalBenutzerSchema }),
  z.object({ status: z.literal('totp_einrichten'), einrichtungsToken: z.string() }),
])
export type PortalAnmeldeAntwort = z.infer<typeof PortalAnmeldeAntwortSchema>

export const TotpEinrichtenAntwortSchema = z.object({
  /** Geheimnis zum Abtippen (Base32) */
  secret:      z.string(),
  /** otpauth://-Adresse für den QR-Code */
  otpauthUrl:  z.string(),
})
export type TotpEinrichtenAntwort = z.infer<typeof TotpEinrichtenAntwortSchema>

export const TotpBestaetigenSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
})
export type TotpBestaetigen = z.infer<typeof TotpBestaetigenSchema>
