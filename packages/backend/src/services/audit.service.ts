/**
 * Audit-Service — protokolliert sicherheitsrelevante Aktionen in der DB.
 *
 * Wird im gesamten Backend verwendet, um ein lückenloses Protokoll zu führen.
 * Fehler beim Schreiben des Audit-Logs werden nur geloggt, nicht weiter propagiert,
 * damit ein DB-Fehler im Audit-Pfad nie die eigentliche Geschäftslogik unterbricht.
 */

import { isIP } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export type AuditAktion =
  | 'login.erfolg'
  | 'login.fehlschlag'
  | 'login.gesperrt'
  | 'pin_login.erfolg'
  | 'pin_login.fehlschlag'
  | 'pin.gesperrt'
  | 'benutzer.erstellt'
  | 'benutzer.geaendert'
  | 'benutzer.geloescht'
  | 'kasse.registriert'
  | 'kasse.deregistriert'
  | 'einstellungen.geaendert'
  | 'jahresbeleg.erstellt'
  | 'nullbeleg.erstellt'
  | 'storno.freigegeben'
  | 'rabatt.freigegeben'
  | 'tickets.ausgestellt'
  | 'ticket.storniert'

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

/**
 * Client-IP eines Fastify-Requests — für Audit-Log und Rate-Limit.
 *
 * Das Backend ist nie direkt erreichbar: jede Anfrage kommt über den nginx einer
 * App, und der ÜBERSCHREIBT X-Real-IP mit der Client-IP, die er je Eingang
 * bestimmt (direkt, Caddy, Cloudflare-Tunnel — siehe den Client-IP-Block in
 * packages/<app>/nginx.conf). X-Forwarded-For wird bewusst nicht gelesen: dessen
 * erster Eintrag stammt vom Client selbst und ist frei fälschbar.
 * Ohne (gültiges) X-Real-IP — Dev-Server, Healthcheck — zählt der Absender.
 */
export function getClientIp(request: {
  ip: string
  headers: Record<string, string | string[] | undefined>
}): string {
  const wert = request.headers['x-real-ip']
  const ip = (Array.isArray(wert) ? wert[0] : wert)?.trim()
  return ip && isIP(ip) ? ip : request.ip
}
