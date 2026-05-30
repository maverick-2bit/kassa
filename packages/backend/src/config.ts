/**
 * Server-Konfiguration aus Umgebungsvariablen.
 * Wird beim Start validiert — fehlt eine Pflichtvariable, bricht der Server ab.
 */

import { z } from 'zod'

const ConfigSchema = z.object({
  DATABASE_URL:      z.string().url(),
  MASTER_PASSPHRASE: z.string().min(16, 'MASTER_PASSPHRASE muss mindestens 16 Zeichen lang sein'),
  /** JWT-Signing-Key — geheim, lang, in Produktion zufällig generieren */
  JWT_SECRET:        z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen lang sein'),
  /** JWT-Gültigkeitsdauer als Fastify-JWT-Format, z. B. "8h", "30m" */
  JWT_EXPIRES_IN:    z.string().default('8h'),
  PORT:              z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL:         z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN:       z.string().default('http://localhost:5173'),
  NODE_ENV:          z.enum(['development', 'test', 'production']).default('development'),
  /** Verzeichnis für DEP-Sicherungsdateien (absolut oder relativ zum CWD) */
  DEP_BACKUP_DIR:    z.string().default('./dep-backups'),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    const formatted = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Ungültige Konfiguration:\n${formatted}`)
  }
  return result.data
}
