/**
 * Portal-Konfiguration aus Umgebungsvariablen.
 * Wird beim Start validiert — fehlt eine Pflichtvariable, bricht das Portal ab.
 */

import { z } from 'zod'

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  /** Signiert die Sitzungen. Geheim, zufällig, mindestens 32 Zeichen. */
  PORTAL_JWT_SECRET: z.string().min(32, 'PORTAL_JWT_SECRET muss mindestens 32 Zeichen lang sein'),
  /** Verschlüsselt die TOTP-Geheimnisse in der Datenbank. Geheim, zufällig, mindestens 32 Zeichen. */
  PORTAL_MASTER_KEY: z.string().min(32, 'PORTAL_MASTER_KEY muss mindestens 32 Zeichen lang sein'),
  PORT:      z.coerce.number().int().min(1).max(65535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV:  z.enum(['development', 'test', 'production']).default('development'),
  /** Hinter einem Reverse-Proxy: die echte Client-Adresse aus X-Forwarded-For nehmen (Rate-Limit, Log). */
  TRUST_PROXY: z.string().optional().default('false').transform(v => v === 'true' || v === '1'),
  /** Erlaubter Ursprung einer getrennt ausgelieferten Oberfläche. Leer = kein CORS. */
  CORS_ORIGIN: z.string().optional().default('').transform(v => v.trim()),
  /** Nach so vielen Sekunden ohne Meldung gilt eine Box als offline. */
  PORTAL_OFFLINE_NACH_SEKUNDEN: z.coerce.number().int().min(60).max(86_400).default(600),
  /** Gültigkeit einer Sitzung in Stunden. */
  PORTAL_SITZUNG_STUNDEN: z.coerce.number().int().min(1).max(72).default(8),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    const probleme = result.error.issues.map(i => `  - ${i.path.join('.') || '(Konfiguration)'}: ${i.message}`).join('\n')
    throw new Error(`Ungültige Portal-Konfiguration:\n${probleme}`)
  }
  return result.data
}
