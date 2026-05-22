import { z } from 'zod'

// ---------------------------------------------------------------------------
// ZVT-Konfiguration (pro Kasse)
// ---------------------------------------------------------------------------

export const ZvtConfigSchema = z.object({
  zvtIp:       z.string().nullable(),
  zvtPort:     z.number().int().min(1).max(65535),
  zvtPasswort: z.string().nullable(),
  zvtAktiv:    z.boolean(),
})
export type ZvtConfig = z.infer<typeof ZvtConfigSchema>

export const ZvtConfigUpdateSchema = ZvtConfigSchema.partial()
export type ZvtConfigUpdate = z.infer<typeof ZvtConfigUpdateSchema>

// ---------------------------------------------------------------------------
// Job-Lifecycle
// ---------------------------------------------------------------------------

export const ZvtJobStatusSchema = z.enum([
  'verbinde',     // TCP-Connect läuft
  'autorisiere', // Authorization-Paket gesendet, warte auf Terminal
  'erfolg',       // Zahlung erfolgreich
  'abgebrochen', // Vom Kassier abgebrochen
  'fehler',       // Verbindung/Karte abgelehnt/Timeout
])
export type ZvtJobStatus = z.infer<typeof ZvtJobStatusSchema>

export const ZvtErgebnisSchema = z.object({
  /** Trace-Nummer vom Terminal (für Reklamation/Storno) */
  traceNummer:    z.string().optional(),
  /** Beleg-Nummer vom Terminal (falls vom Terminal vergeben) */
  belegnummer:    z.string().optional(),
  /** Karten-Brand falls vom Terminal mitgeteilt (z. B. "VISA") */
  kartenmarke:    z.string().optional(),
  /** PAN maskiert (z. B. "************1234") */
  panMaskiert:    z.string().optional(),
  /** Autorisierungs-Code */
  autorisierung:  z.string().optional(),
  /** Vom Terminal gedruckte Bon-Zeilen (falls Print-Daten kamen) */
  bonZeilen:      z.array(z.string()).optional(),
})
export type ZvtErgebnis = z.infer<typeof ZvtErgebnisSchema>

// ---------------------------------------------------------------------------
// Job-Status-Response (Polling)
// ---------------------------------------------------------------------------

export const ZvtJobSchema = z.object({
  id:          z.string().uuid(),
  status:      ZvtJobStatusSchema,
  betragCent:  z.number().int().positive(),
  /** Kurze Status-Meldung für die UI ("Warte auf Karte", "PIN-Eingabe", …) */
  meldung:     z.string().optional(),
  ergebnis:    ZvtErgebnisSchema.optional(),
  fehler:      z.string().optional(),
  gestartetAm: z.string(),
  beendetAm:   z.string().optional(),
})
export type ZvtJob = z.infer<typeof ZvtJobSchema>

// ---------------------------------------------------------------------------
// Input: Zahlung starten
// ---------------------------------------------------------------------------

export const ZvtZahlungInputSchema = z.object({
  kasseId:    z.string().uuid(),
  betragCent: z.number().int().positive(),
})
export type ZvtZahlungInput = z.infer<typeof ZvtZahlungInputSchema>
