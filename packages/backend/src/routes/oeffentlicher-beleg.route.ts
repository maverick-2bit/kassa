/**
 * Öffentliche Beleg-Route — digitaler Beleg (KEIN JWT).
 *
 *   GET /api/oeffentlich/beleg/:belegId
 *
 * Der Gast scannt an der Kassa / am Kundendisplay einen QR-Code, der auf die
 * öffentliche Web-Ansicht `/beleg/:belegId` zeigt; diese lädt hier den Beleg.
 * Zugriff über die (nicht erratbare) Beleg-UUID. Es wird ein REDUZIERTER Beleg
 * geliefert — der Kunde-Block wird bewusst weggelassen (Privatsphäre): der
 * öffentliche Beleg zeigt die Transaktion, nicht die Kundenidentität.
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen, mandanten } from '../db/schema.js'
import { belegRowZuDto } from '../services/drucker.service.js'

export interface OeffentlicherBelegRouteOptions { db: Db }

const BelegIdParam = z.object({ belegId: z.string().uuid() })

export const oeffentlicherBelegRoute: FastifyPluginAsync<OeffentlicherBelegRouteOptions> = async (fastify, opts) => {
  // Kein auth-Guard — bewusst öffentlich.
  fastify.get('/oeffentlich/beleg/:belegId', async (request, reply) => {
    const p = BelegIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Beleg-ID' })

    const [beleg] = await opts.db.select().from(belege).where(eq(belege.id, p.data.belegId)).limit(1)
    if (!beleg) return reply.status(404).send({ fehler: 'Beleg nicht gefunden' })

    const [mandant] = await opts.db
      .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
      .from(mandanten).where(eq(mandanten.id, beleg.mandantId)).limit(1)
    if (!mandant) return reply.status(404).send({ fehler: 'Beleg nicht gefunden' })

    const [kasse] = await opts.db
      .select({ kassenId: kassen.kassenId })
      .from(kassen).where(eq(kassen.id, beleg.kasseId)).limit(1)

    // belegRowZuDto enthält KEINEN Kunde-Block → für den öffentlichen Beleg genau richtig.
    return reply.send({
      firmenname: mandant.firmenname,
      uid:        mandant.uid,
      kassenId:   kasse?.kassenId ?? '',
      beleg:      belegRowZuDto(beleg),
    })
  })
}
