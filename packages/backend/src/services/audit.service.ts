/**
 * Audit-Service — protokolliert sicherheitsrelevante Aktionen in der DB.
 *
 * Wird im gesamten Backend verwendet, um ein lückenloses Protokoll zu führen.
 * Fehler beim Schreiben des Audit-Logs werden nur geloggt, nicht weiter propagiert,
 * damit ein DB-Fehler im Audit-Pfad nie die eigentliche Geschäftslogik unterbricht.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export type AuditAktion =
  | 'login.erfolg'
  | 'login.fehlschlag'
  | 'login.gesperrt'
  | 'pin_login.erfolg'
  | 'pin_login.fehlschlag'
  | 'benutzer.erstellt'
  | 'benutzer.geaendert'
  | 'benutzer.geloescht'
  | 'kasse.registriert'
  | 'kasse.deregistriert'
  | 'einstellungen.geaendert'
  | 'jahresbeleg.erstellt'
  | 'nullbeleg.erstellt'

export interface AuditEintrag {
  mandantId?: string | null
  userId?:    string | null
  aktion:     AuditAktion
  details?:   Record<string, unknown>
  ipAdresse?: string | null
  userAgent?: string | null
}

export async function logAudit(
  db:      Db,
  eintrag: AuditEintrag,
  log?:    FastifyBaseLogger,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      mandantId: eintrag.mandantId ?? null,
      userId:    eintrag.userId    ?? null,
      aktion:    eintrag.aktion,
      details:   eintrag.details   ?? null,
      ipAdresse: eintrag.ipAdresse ?? null,
      userAgent: eintrag.userAgent ?? null,
    })
  } catch (err) {
    // Audit-Log-Fehler dürfen die eigentliche Aktion nie blockieren
    log?.error({ err, eintrag }, 'Audit-Log konnte nicht geschrieben werden')
  }
}

/** Extrahiert die Client-IP aus einem Fastify-Request (inkl. X-Forwarded-For hinter Proxy). */
export function getClientIp(request: {
  ip: string
  headers: Record<string, string | string[] | undefined>
}): string {
  const forwarded = request.headers['x-forwarded-for']
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    return (first ?? request.ip).trim()
  }
  return request.ip
}
