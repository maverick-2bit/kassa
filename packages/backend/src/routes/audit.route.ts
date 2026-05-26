/**
 * Audit-Log-Routen
 *   GET /api/audit-log   Protokoll sicherheitsrelevanter Aktionen (nur Admin/Einstellungen)
 */

import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export interface AuditRouteOptions { db: Db }

export const auditRoute: FastifyPluginAsync<AuditRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  /**
   * GET /api/audit-log?seite=1&limit=50&aktion=login.fehlschlag
   *
   * Liefert paginierten Audit-Log des Mandanten.
   * Erfordert Admin-Rolle oder die Berechtigung „einstellungen".
   */
  fastify.get('/audit-log', auth, async (request, reply) => {
    const user = request.user

    const darfSehen =
      user.rolle === 'admin' ||
      (user.berechtigungen ?? []).includes('einstellungen')

    if (!darfSehen) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung für das Audit-Log' })
    }

    const query  = request.query as Record<string, string>
    const seite  = Math.max(1, parseInt(query['seite']  ?? '1',  10))
    const limit  = Math.min(100, Math.max(1, parseInt(query['limit'] ?? '50', 10)))
    const offset = (seite - 1) * limit
    const aktion = query['aktion'] ?? null

    const bedingungen = [eq(auditLogs.mandantId, user.mandantId)]
    if (aktion) bedingungen.push(eq(auditLogs.aktion, aktion))

    const eintraege = await opts.db
      .select()
      .from(auditLogs)
      .where(and(...bedingungen))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset)

    return reply.send({ eintraege, seite, limit })
  })
}
