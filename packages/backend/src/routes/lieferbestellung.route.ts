/**
 * Lieferbestellungs-Routen
 *
 *  GET    /api/lieferbestellungen?kasseId=&nurNeu=true&limit=100
 *    → Liste eingehender Delivery-Bestellungen
 *
 *  PATCH  /api/lieferbestellungen/:id
 *    → Status-Update (bestaetigt | fertig | abgelehnt | storniert)
 *
 *  GET    /api/kassen/:kasseId/webhook-url
 *    → Liefert die konfigurierten Webhook-URLs + Secret für Einstellungsseite
 *
 *  POST   /api/webhooks/:provider/:kasseId?secret=...
 *    → Eingehender Webhook (KEINE Auth — validiert über secret-Parameter)
 *    → provider: lieferando | mergeport | custom
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, mandanten } from '../db/schema.js'
import {
  erstelleBestellung,
  listeBestellungen,
  aktualisiereBestellungStatus,
} from '../services/lieferbestellung.service.js'
import { LieferbestellungUpdateSchema } from '@kassa/shared'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface LieferbestellungRouteOptions { db: Db }

const ListQuerySchema = z.object({
  kasseId: z.string().uuid(),
  limit:   z.coerce.number().int().min(1).max(500).optional(),
  nurNeu:  z.enum(['true', 'false']).optional(),
})

const IdParam = z.object({ id: z.string().uuid() })

const WebhookParams = z.object({
  provider: z.enum(['lieferando', 'mergeport', 'custom']),
  kasseId:  z.string().uuid(),
})

const WebhookQuery = z.object({
  secret: z.string().min(1),
})

export const lieferbestellungRoute: FastifyPluginAsync<LieferbestellungRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  // ---- GET /lieferbestellungen ----
  fastify.get('/lieferbestellungen', guard, async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const ok = await pruefeKasseGehoertZuMandant(opts.db, parsed.data.kasseId, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const liste = await listeBestellungen(opts.db, parsed.data.kasseId, {
      ...(parsed.data.limit  !== undefined && { limit:  parsed.data.limit }),
      ...(parsed.data.nurNeu !== undefined && { nurNeu: parsed.data.nurNeu === 'true' }),
    })
    return reply.send(liste)
  })

  // ---- PATCH /lieferbestellungen/:id ----
  fastify.patch('/lieferbestellungen/:id', guard, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    const body = LieferbestellungUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const updated = await aktualisiereBestellungStatus(
        opts.db,
        p.data.id,
        request.user.mandantId,
        body.data.status,
      )
      return reply.send(updated)
    } catch (err) {
      return reply.status(404).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })

  // ---- GET /kassen/:kasseId/webhook-url ----
  // Gibt die Webhook-URLs + Secret für die Einstellungsseite zurück
  fastify.get('/kassen/:kasseId/webhook-url', guard, async (request, reply) => {
    const p = z.object({ kasseId: z.string().uuid() }).safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const [kasse] = await opts.db
      .select({ id: kassen.id, webhookSecret: kassen.webhookSecret })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const baseUrl = (request.headers['x-forwarded-proto'] ?? 'https') +
      '://' + (request.headers['x-forwarded-host'] ?? request.hostname)

    const mkUrl = (provider: string) =>
      `${baseUrl}/api/webhooks/${provider}/${kasse.id}?secret=${kasse.webhookSecret}`

    return reply.send({
      webhookSecret:  kasse.webhookSecret,
      urls: {
        lieferando: mkUrl('lieferando'),
        mergeport:  mkUrl('mergeport'),
        custom:     mkUrl('custom'),
      },
    })
  })

  // ---- POST /webhooks/:provider/:kasseId ----
  // Kein JWT — validiert über secret-Query-Parameter
  fastify.post('/webhooks/:provider/:kasseId', async (request, reply) => {
    const params = WebhookParams.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige Parameter' })

    const query = WebhookQuery.safeParse(request.query)
    if (!query.success) return reply.status(401).send({ fehler: 'Secret fehlt' })

    // Kasse laden + Secret prüfen
    const [kasse] = await opts.db
      .select({ id: kassen.id, webhookSecret: kassen.webhookSecret, mandantId: kassen.mandantId })
      .from(kassen)
      .where(eq(kassen.id, params.data.kasseId))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    if (kasse.webhookSecret !== query.data.secret) {
      return reply.status(401).send({ fehler: 'Ungültiges Secret' })
    }

    // Modul-Check: Lieferservice-Integration muss für den Mandanten aktiviert sein
    const [mandant] = await opts.db
      .select({ modulMergeportAktiv: mandanten.modulMergeportAktiv })
      .from(mandanten)
      .where(eq(mandanten.id, kasse.mandantId))
      .limit(1)

    if (!mandant?.modulMergeportAktiv) {
      return reply.status(403).send({ fehler: 'Lieferservice-Modul nicht aktiviert' })
    }

    try {
      const bestellung = await erstelleBestellung(
        opts.db,
        params.data.kasseId,
        params.data.provider,
        request.body,
      )
      return reply.status(201).send(bestellung)
    } catch (err) {
      fastify.log.error({ err }, 'Webhook-Verarbeitung fehlgeschlagen')
      return reply.status(500).send({ fehler: err instanceof Error ? err.message : 'Fehler' })
    }
  })
}
