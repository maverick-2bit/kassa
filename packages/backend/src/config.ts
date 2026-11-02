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
  /**
   * Stubt FinanzOnline (keine echten SOAP-Calls) — für lokale Entwicklung/E2E,
   * damit eine Kasse ohne echte FO-Testzugangsdaten eingerichtet werden kann.
   * In Produktion verboten (index.ts bricht beim Start ab).
   */
  FO_STUB:           z.string().optional().default('false').transform(v => v === 'true' || v === '1'),

  /**
   * Geheimes Token für den externen Monitoring-Endpoint (GET /api/monitoring/status
   * ?token=…). Nicht gesetzt = Endpoint deaktiviert (404). Für Uptime-Monitore
   * (Healthchecks.io, Uptime Kuma): 200 = gesund, 503 = degradiert.
   */
  MONITORING_TOKEN:  z.string().optional(),

  /**
   * Einrichtungs-Schlüssel (optional): Wer ihn im Header `x-setup-token` mitschickt, darf
   * POST /api/setup auch auf einer SCHON EINGERICHTETEN Installation aufrufen und einen weiteren
   * Mandanten anlegen — ohne als Betreiber angemeldet zu sein. Gedacht als Notweg und für Skripte
   * und Tests; im Alltag legt der angemeldete Betreiber Mandanten an. Leer oder nicht gesetzt =
   * dieser Weg ist zu. Mindestens 24 Zeichen (der Schlüssel schützt die ganze Installation).
   */
  SETUP_TOKEN: z.string().optional()
    .transform(v => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine(v => v === undefined || v.length >= 24, 'SETUP_TOKEN muss mindestens 24 Zeichen lang sein'),
  /** Schwelle (Stunden), ab der die letzte DB-Sicherung als veraltet gilt. */
  DB_BACKUP_MAX_AGE_STUNDEN:  z.coerce.number().int().min(1).default(26),
  /** Schwelle (Stunden), ab der die letzte DEP-Sicherung als veraltet gilt. */
  DEP_BACKUP_MAX_AGE_STUNDEN: z.coerce.number().int().min(1).default(26),
  /** Verzeichnis für DEP-Sicherungsdateien (absolut oder relativ zum CWD) */
  DEP_BACKUP_DIR:    z.string().default('./dep-backups'),
  /** Verzeichnis für PostgreSQL-DB-Dumps */
  DB_BACKUP_DIR:     z.string().default('./db-backups'),
  /** Anzahl DB-Backups die aufbewahrt werden (ältere werden gelöscht) */
  DB_BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(30),

  // ── SMTP (optional — wenn nicht gesetzt, ist E-Mail-Versand deaktiviert) ──
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // ── Stripe (optional — fehlen die Keys, ist die Gast-Onlinezahlung deaktiviert
  //    und läuft nur der Demo-Pfad in Dev/Test). Ein globales Konto. ──
  STRIPE_SECRET_KEY:     z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
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
