import { z } from 'zod'

// ---------------------------------------------------------------------------
// Signaturerstellungseinheit (SEE) — Konfiguration je Kasse
// ---------------------------------------------------------------------------

export const SeeTypSchema = z.enum(['software', 'atrust_hsm', 'atrust_chip'])
export type SeeTyp = z.infer<typeof SeeTypSchema>

export const SEE_TYP_LABELS: Record<SeeTyp, string> = {
  software:    'Software (nur Entwicklung/Test)',
  atrust_hsm:  'A-Trust a.sign RK HSM (Cloud)',
  atrust_chip: 'A-Trust a.sign RK CHIP (Signaturkarte, lokal — ohne Internet)',
}

/** Karten-PIN der Signaturkarte: nur Ziffern, 4 bis 12 Stellen */
export const KartePinSchema = z.string().regex(/^\d{4,12}$/, 'Die Karten-PIN besteht aus 4 bis 12 Ziffern')

/** Aktuelle SEE-Konfiguration einer Kasse (ohne Geheimnisse) */
export const SeeConfigSchema = z.object({
  seeTyp:                SeeTypSchema,
  seeZdaId:              z.string(),
  atrustBasisUrl:        z.string().nullable(),
  atrustBenutzer:        z.string().nullable(),
  /** true = ein A-Trust-Passwort ist hinterlegt (Wert wird nie ausgeliefert) */
  atrustPasswortGesetzt: z.boolean(),
  /** Signaturkarte: true = eine PIN ist hinterlegt (Wert wird nie ausgeliefert) */
  kartePinGesetzt:       z.boolean(),
  /** Signaturkarte: true = die Karte hat die PIN abgelehnt — die Kassa signiert erst nach neuer PIN wieder */
  kartePinGesperrt:      z.boolean(),
  /** Wortlaut der letzten PIN-Ablehnung (z. B. „noch 2 Versuche") */
  kartePinHinweis:       z.string().nullable(),
  zertifikatSn:          z.string(),
  zertifikatGueltigBis:  z.string(),
})
export type SeeConfig = z.infer<typeof SeeConfigSchema>

/** Die beiden Server von A-Trust, an die Zugangsdaten gehen dürfen: Produktion und Abnahme (Test). */
export const ATRUST_ERLAUBTE_HOSTS: readonly string[] = ['hs.a-trust.at', 'hs-abnahme.a-trust.at']

/**
 * Darf an diese Adresse ein A-Trust-Passwort geschickt werden?
 *
 * Die Kassa schickt bei „Verbindung testen", „Speichern" und jeder Signatur Benutzer UND Passwort an
 * die eingetragene Basis-URL. Ist sie frei wählbar, genügt es, sie auf einen eigenen Server zu stellen —
 * das gespeicherte Passwort kommt von selbst dorthin. Darum nur https und genau die A-Trust-Hosts, ohne
 * Zugangsdaten in der Adresse (`https://hs.a-trust.at@fremd.example`) und ohne fremden Port.
 *
 * `lokalErlaubt` (Entwicklung/Tests, NIE in Produktion): zusätzlich Mock-Server auf dem eigenen Rechner.
 */
export function istErlaubteAtrustBasisUrl(roh: string, optionen: { lokalErlaubt?: boolean } = {}): boolean {
  let url: URL
  try { url = new URL(roh) } catch { return false }
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:' && ATRUST_ERLAUBTE_HOSTS.includes(url.hostname) && (url.port === '' || url.port === '443')) {
    return true
  }
  if (optionen.lokalErlaubt) {
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  }
  return false
}

export const SeeConfigUpdateSchema = z.object({
  seeTyp:         SeeTypSchema,
  atrustBasisUrl: z.string().url().max(300).optional(),
  atrustBenutzer: z.string().trim().min(1).max(100).optional(),
  /** Optional beim Update, wenn bereits ein Passwort hinterlegt ist */
  atrustPasswort: z.string().min(1).max(200).optional(),
  /**
   * Signaturkarte: PIN. Beim Speichern prüft die Kassa sie mit EINER Probesignatur auf der Karte
   * (falsch = ein Fehlversuch, nichts wird gespeichert). Optional, wenn schon eine gültige PIN hinterlegt ist.
   */
  kartePin:       KartePinSchema.optional(),
})
export type SeeConfigUpdate = z.infer<typeof SeeConfigUpdateSchema>

/** Ergebnis von „Verbindung testen" bzw. der Übernahme beim Speichern */
export const SeeTestErgebnisSchema = z.object({
  erfolgreich:   z.boolean(),
  zdaId:         z.string().optional(),
  zertifikatSn:  z.string().optional(),
  fehler:        z.string().optional(),
  /** Signaturkarte: erkannte Karte (z. B. „A-Trust ACOS-ID 4.1") */
  karte:         z.string().optional(),
  /** Signaturkarte: Hinweis, z. B. „bis Mai 2027 tauschen" */
  hinweis:       z.string().optional(),
})
export type SeeTestErgebnis = z.infer<typeof SeeTestErgebnisSchema>
