/**
 * Zod-Schemas für die Kasseneinrichtung.
 * Werden von Backend (API-Validierung) und Frontend (Formular-Validierung) gemeinsam genutzt.
 */

import { z } from 'zod'
import { AdminUserInputSchema } from './auth.js'

// ---------------------------------------------------------------------------
// FinanzOnline-Zugangsdaten
// ---------------------------------------------------------------------------

export const FinanzOnlineCredentialsSchema = z.object({
  teilnehmerId:    z.string().trim().min(1, 'Teilnehmer-ID (TID) ist erforderlich'),
  benutzerkennung: z.string().trim().min(1, 'Benutzerkennung (BenID) ist erforderlich'),
  pin:             z.string().min(1, 'PIN ist erforderlich'),
})

export type FinanzOnlineCredentialsInput = z.infer<typeof FinanzOnlineCredentialsSchema>

// ---------------------------------------------------------------------------
// Setup-Eingabe (Formular)
// ---------------------------------------------------------------------------

export const SetupModuleSchema = z.object({
  gastro:         z.boolean().default(true),
  angebote:       z.boolean().default(false),
  mergeport:      z.boolean().default(false),
  reservierungen: z.boolean().default(false),
  zeiterfassung:  z.boolean().default(false),
  sbTerminal:     z.boolean().default(false),
})
export type SetupModule = z.infer<typeof SetupModuleSchema>

export const SetupInputSchema = z.object({
  firmenname: z.string().trim().min(1, 'Firmenname ist erforderlich'),
  uid:        z.string().trim().regex(/^ATU\d{8}$/, 'UID ungültig (Format: ATU + 8 Ziffern)'),
  kassenId:   z.string().trim().min(1, 'Kassen-ID ist erforderlich').max(40),
  /**
   * FinanzOnline-Zugangsdaten. Optional: fehlen sie (oder sind alle Felder
   * leer), wird die Kasse provisorisch (ohne FON-Registrierung) eingerichtet —
   * die Registrierung ist später nachzutragen. Teilangaben (nur 1–2 Felder)
   * sind ein Fehler: entweder alle drei oder keines.
   */
  finanzOnline: z.preprocess((v) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const leer =
        !String(o.teilnehmerId ?? '').trim() &&
        !String(o.benutzerkennung ?? '').trim() &&
        !String(o.pin ?? '').trim()
      if (leer) return undefined
    }
    return v
  }, FinanzOnlineCredentialsSchema.optional()),
  umgebung:   z.enum(['test', 'produktion']).default('test'),
  /** Admin-Benutzer für den ersten Login nach Setup */
  admin:      AdminUserInputSchema,
  /** Optional: Gültigkeitsdauer des Zertifikats in Tagen (Standard: 5 Jahre) */
  zertifikatGueltigkeitTage: z.number().int().min(30).max(3650).optional(),
  /** Welche Module beim Setup aktiviert werden sollen */
  module: SetupModuleSchema.default({ gastro: true, angebote: false, mergeport: false, reservierungen: false, zeiterfassung: false, sbTerminal: false }),
})

export type SetupInput = z.infer<typeof SetupInputSchema>

// ---------------------------------------------------------------------------
// Setup-Ergebnis (Response)
// ---------------------------------------------------------------------------

export const EinrichtungsSchrittSchema = z.object({
  schritt: z.enum([
    'eingabe-validierung',
    'see-generierung',
    'finanzonline-registrierung',
    'startbeleg-erstellung',
    'startbeleg-pruefung',
  ]),
  status:      z.enum(['startet', 'erfolgreich', 'fehler']),
  meldung:     z.string(),
  zeitstempel: z.string().datetime(),
})

export type EinrichtungsSchrittDto = z.infer<typeof EinrichtungsSchrittSchema>

export const SetupResponseSchema = z.object({
  erfolgreich: z.boolean(),
  mandantId:   z.string().uuid().optional(),
  kasseId:     z.string().uuid().optional(),
  startbelegNummer: z.number().int().optional(),
  startbelegMaschinenlesbareCode: z.string().optional(),
  pruefwert:   z.string().optional(),
  schritte:    z.array(EinrichtungsSchrittSchema),
  fehler:      z.string().optional(),
})

export type SetupResponse = z.infer<typeof SetupResponseSchema>

// ---------------------------------------------------------------------------
// Weitere Kasse anlegen (für bestehenden Mandanten)
// ---------------------------------------------------------------------------

/**
 * Eingabe zum Anlegen einer *weiteren* Registrierkasse für einen bereits
 * eingerichteten Mandanten. Firmenname/UID kommen vom Mandanten, ein neuer
 * Admin/Module werden nicht angelegt. Es entsteht eine eigene SEE-Einheit
 * (Zertifikat + Private Key) samt eigenem Startbeleg.
 */
export const WeitereKasseInputSchema = z.object({
  kassenId:    z.string().trim().min(1, 'Kassen-ID ist erforderlich').max(40),
  bezeichnung: z.string().trim().max(100).optional(),
  umgebung:    z.enum(['test', 'produktion']).default('test'),
  /** Wie beim Setup: alle drei Felder oder keines (dann provisorisch ohne FON). */
  finanzOnline: z.preprocess((v) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const leer =
        !String(o.teilnehmerId ?? '').trim() &&
        !String(o.benutzerkennung ?? '').trim() &&
        !String(o.pin ?? '').trim()
      if (leer) return undefined
    }
    return v
  }, FinanzOnlineCredentialsSchema.optional()),
  zertifikatGueltigkeitTage: z.number().int().min(30).max(3650).optional(),
})
export type WeitereKasseInput = z.infer<typeof WeitereKasseInputSchema>

export const WeitereKasseResponseSchema = z.object({
  erfolgreich:      z.boolean(),
  kasseId:          z.string().uuid().optional(),
  startbelegNummer: z.number().int().optional(),
  schritte:         z.array(EinrichtungsSchrittSchema),
  fehler:           z.string().optional(),
})
export type WeitereKasseResponse = z.infer<typeof WeitereKasseResponseSchema>

/** Ein Eintrag der Kassen-Liste (Verwaltung/Umschalter). */
export const KasseListeItemSchema = z.object({
  id:               z.string().uuid(),
  kassenId:         z.string(),
  bezeichnung:      z.string().nullable(),
  status:           z.string(),
  umgebung:         z.string(),
  seeGueltigBis:    z.string(),
  beiFoRegistriert: z.boolean(),
  /** ISO-Zeitpunkt der Außerbetriebnahme; null = in Betrieb */
  ausserBetriebAm:  z.string().nullable(),
})
export type KasseListeItem = z.infer<typeof KasseListeItemSchema>
