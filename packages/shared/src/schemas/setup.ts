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
})
export type SetupModule = z.infer<typeof SetupModuleSchema>

export const SetupInputSchema = z.object({
  firmenname: z.string().trim().min(1, 'Firmenname ist erforderlich'),
  uid:        z.string().trim().regex(/^ATU\d{8}$/, 'UID ungültig (Format: ATU + 8 Ziffern)'),
  kassenId:   z.string().trim().min(1, 'Kassen-ID ist erforderlich').max(40),
  finanzOnline: FinanzOnlineCredentialsSchema,
  umgebung:   z.enum(['test', 'produktion']).default('test'),
  /** Admin-Benutzer für den ersten Login nach Setup */
  admin:      AdminUserInputSchema,
  /** Optional: Gültigkeitsdauer des Zertifikats in Tagen (Standard: 5 Jahre) */
  zertifikatGueltigkeitTage: z.number().int().min(30).max(3650).optional(),
  /** Welche Module beim Setup aktiviert werden sollen */
  module: SetupModuleSchema.default({ gastro: true, angebote: false, mergeport: false, reservierungen: false, zeiterfassung: false }),
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
