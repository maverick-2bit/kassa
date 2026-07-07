import { z } from 'zod'

// ---------------------------------------------------------------------------
// Signaturerstellungseinheit (SEE) — Konfiguration je Kasse
// ---------------------------------------------------------------------------

export const SeeTypSchema = z.enum(['software', 'atrust_hsm'])
export type SeeTyp = z.infer<typeof SeeTypSchema>

export const SEE_TYP_LABELS: Record<SeeTyp, string> = {
  software:   'Software (nur Entwicklung/Test)',
  atrust_hsm: 'A-Trust a.sign RK HSM (Cloud)',
}

/** Aktuelle SEE-Konfiguration einer Kasse (ohne Geheimnisse) */
export const SeeConfigSchema = z.object({
  seeTyp:                SeeTypSchema,
  seeZdaId:              z.string(),
  atrustBasisUrl:        z.string().nullable(),
  atrustBenutzer:        z.string().nullable(),
  /** true = ein A-Trust-Passwort ist hinterlegt (Wert wird nie ausgeliefert) */
  atrustPasswortGesetzt: z.boolean(),
  zertifikatSn:          z.string(),
  zertifikatGueltigBis:  z.string(),
})
export type SeeConfig = z.infer<typeof SeeConfigSchema>

export const SeeConfigUpdateSchema = z.object({
  seeTyp:         SeeTypSchema,
  atrustBasisUrl: z.string().url().optional(),
  atrustBenutzer: z.string().trim().min(1).max(100).optional(),
  /** Optional beim Update, wenn bereits ein Passwort hinterlegt ist */
  atrustPasswort: z.string().min(1).max(200).optional(),
})
export type SeeConfigUpdate = z.infer<typeof SeeConfigUpdateSchema>

/** Ergebnis von „Verbindung testen" bzw. der Übernahme beim Speichern */
export const SeeTestErgebnisSchema = z.object({
  erfolgreich:   z.boolean(),
  zdaId:         z.string().optional(),
  zertifikatSn:  z.string().optional(),
  fehler:        z.string().optional(),
})
export type SeeTestErgebnis = z.infer<typeof SeeTestErgebnisSchema>
