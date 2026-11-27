/**
 * Verwaltung und Übersicht — alles nur mit Sitzung.
 *
 *   GET   /api/uebersicht                      alle Betriebe mit ihren Boxen und deren Status
 *   POST  /api/betriebe                        Betrieb anlegen
 *   PATCH /api/betriebe/:id                    Name, Notiz, aktiv, gebuchte Module
 *   POST  /api/betriebe/:id/boxen              Box anlegen → Token (nur jetzt sichtbar)
 *   GET   /api/boxen/:id                       Detail: Meldung, Gründe, Fehlerberichte
 *   PATCH /api/boxen/:id                       Name, aktiv
 *   POST  /api/boxen/:id/token-erneuern        neues Token (das alte gilt sofort nicht mehr)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  BetriebAktualisierenSchema, BetriebAnlegenSchema, BoxAktualisierenSchema, BoxAnlegenSchema,
} from '@kassa/shared'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import {
  aktualisiereBetrieb, aktualisiereBox, erneuereBoxToken, holeBoxDetail, holeUebersicht, legeBetriebAn, legeBoxAn,
  type Zeitrahmen,
} from '../services/verwaltung.service.js'

export interface VerwaltungRouteOptions {
  config: Config
  db:     Db
  jetzt:  () => Date
}

const IdParam = z.object({ id: z.string().guid() })

export const verwaltungRoute: FastifyPluginAsync<VerwaltungRouteOptions> = async (fastify, opts) => {
  const { config, db, jetzt } = opts
  const auth = { onRequest: [fastify.authentifiziere] }
  const zeitrahmen = (): Zeitrahmen => ({ jetzt: jetzt(), offlineNachSekunden: config.PORTAL_OFFLINE_NACH_SEKUNDEN })

  fastify.get('/uebersicht', auth, async (_request, reply) => reply.send(await holeUebersicht(db, zeitrahmen())))

  fastify.post('/betriebe', auth, async (request, reply) => {
    const eingabe = BetriebAnlegenSchema.safeParse(request.body)
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Bitte einen Namen eingeben.' })
    return reply.status(201).send(await legeBetriebAn(db, eingabe.data))
  })

  fastify.patch('/betriebe/:id', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    const eingabe = BetriebAktualisierenSchema.safeParse(request.body)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Ungültige Eingabe' })
    await aktualisiereBetrieb(db, p.data.id, eingabe.data, jetzt())
    return reply.status(204).send()
  })

  fastify.post('/betriebe/:id/boxen', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    const eingabe = BoxAnlegenSchema.safeParse(request.body)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Bitte einen Namen eingeben.' })
    return reply.status(201).send(await legeBoxAn(db, p.data.id, eingabe.data.name, zeitrahmen()))
  })

  fastify.get('/boxen/:id', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    return reply.send(await holeBoxDetail(db, p.data.id, zeitrahmen()))
  })

  fastify.patch('/boxen/:id', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    const eingabe = BoxAktualisierenSchema.safeParse(request.body)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    if (!eingabe.success) return reply.status(400).send({ fehler: 'Ungültige Eingabe' })
    await aktualisiereBox(db, p.data.id, eingabe.data, jetzt())
    return reply.status(204).send()
  })

  fastify.post('/boxen/:id/token-erneuern', auth, async (request, reply) => {
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    return reply.send(await erneuereBoxToken(db, p.data.id, zeitrahmen()))
  })
}
