/**
 * Kassenbuch-Routen — auth-protected.
 *   GET  /api/kassenbuch           Buchungen + Summen für Zeitraum
 *   POST /api/kassenbuch           Neue Buchung anlegen
 *   POST /api/kassenbuch/drucken   Kassenbuch auf Thermodrucker ausgeben
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { KassenbuchBuchungInputSchema, KassenbuchQuerySchema } from '@kassa/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, mandanten } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import {
  erstelleKassenbuchBuchung,
  listeKassenbuchBuchungen,
} from '../services/kassenbuch.service.js'
import { druckerConfigVonKasse, sendBytes, DruckerError } from '../services/drucker.service.js'
import { baueKassenbuchBon } from '../services/escpos/layout.js'

export interface KassenbuchRouteOptions { db: Db }

export const kassenbuchRoute: FastifyPluginAsync<KassenbuchRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/kassenbuch', guard, async (request, reply) => {
    const parsed = KassenbuchQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const result = await listeKassenbuchBuchungen(
      opts.db,
      parsed.data.kasseId,
      parsed.data.von,
      parsed.data.bis,
    )
    return reply.send(result)
  })

  fastify.post('/kassenbuch', guard, async (request, reply) => {
    // mandantId aus Body ignorieren — immer aus JWT + kasseId-Prüfung
    const parsed = KassenbuchBuchungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    if (!(await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const buchung = await erstelleKassenbuchBuchung(
      opts.db,
      parsed.data.kasseId,
      request.user.sub,
      parsed.data.typ,
      parsed.data.betragCent,
      parsed.data.grund ?? null,
      parsed.data.datum,
    )
    return reply.status(201).send(buchung)
  })

  // -------------------------------------------------------------------------
  // POST /kassenbuch/drucken — Kassenbuch auf Thermodrucker drucken
  // -------------------------------------------------------------------------

  const DruckenSchema = z.object({
    kasseId: z.string().uuid(),
    von:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bis:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })

  fastify.post('/kassenbuch/drucken', guard, async (request, reply) => {
    const parsed = DruckenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const { kasseId, von, bis } = parsed.data
    const mandantId = request.user.mandantId

    if (!(await pruefeKasseGehoertZuMandant(opts.db, kasseId, mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, kasseId)).limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const druckerConfig = druckerConfigVonKasse(kasse)
    if (!druckerConfig) {
      return reply.status(409).send({ fehler: 'Drucker ist nicht konfiguriert oder deaktiviert' })
    }

    const [mandant] = await opts.db.select({ firmenname: mandanten.firmenname })
      .from(mandanten)
      .where(eq(mandanten.id, kasse.mandantId))
      .limit(1)
    if (!mandant) return reply.status(404).send({ fehler: 'Mandant nicht gefunden' })

    try {
      const kassenbuch = await listeKassenbuchBuchungen(opts.db, kasseId, von, bis)
      const bytes = baueKassenbuchBon(
        kassenbuch,
        { firmenname: mandant.firmenname, kassenId: kasse.kassenId },
        { breite: druckerConfig.breite },
      )
      await sendBytes(bytes, druckerConfig)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      fastify.log.error({ err }, 'Kassenbuch-Druck fehlgeschlagen')
      return reply.status(502).send({ fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
