/**
 * Preislisten (Sonderpreise je Kunde)
 *
 *   GET    /preislisten                         Liste mit Anzahl Preise/Kunden            (artikel.verwalten oder kunden.verwalten)
 *   POST   /preislisten                         anlegen                                   (artikel.verwalten)
 *   GET    /preislisten/:id                     Detail mit allen Preisen                  (artikel.verwalten)
 *   PUT    /preislisten/:id                     umbenennen / (de)aktivieren               (artikel.verwalten)
 *   DELETE /preislisten/:id                     löschen, Kunden werden freigegeben        (artikel.verwalten)
 *   PUT    /preislisten/:id/preise              Preise setzen (Upsert)                    (artikel.verwalten)
 *   DELETE /preislisten/:id/preise/:artikelId   einen Sonderpreis entfernen               (artikel.verwalten)
 *   GET    /preislisten/fuer-kunde/:kundeId     Liste+Preise des Kunden für die Kasse     (angemeldet)
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { PreislisteInputSchema, PreislistePreiseSetzenSchema, PreislisteUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  PreislisteError,
  aktualisierePreisliste,
  entfernePreis,
  erstellePreisliste,
  holePreisliste,
  listePreislisten,
  loeschePreisliste,
  preislisteFuerKunde,
  setzePreise,
} from '../services/preisliste.service.js'

export interface PreislisteRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().guid() })
const IdArtikelParam = z.object({ id: z.string().guid(), artikelId: z.string().guid() })
const KundeParam = z.object({ kundeId: z.string().guid() })

export const preislisteRoute: FastifyPluginAsync<PreislisteRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')

  /** Lesen (für die Zuweisung am Kunden) darf auch, wer Kunden verwalten darf */
  const darfLesen = (request: FastifyRequest): boolean =>
    darfVerwalten(request) || request.user.berechtigungen.includes('kunden.verwalten')

  const fehlerAntwort = (err: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof PreislisteError) return reply.status(err.httpStatus).send({ fehler: err.message })
    throw err
  }

  // Statischer Pfad vor den :id-Pfaden
  fastify.get('/preislisten/fuer-kunde/:kundeId', auth, async (request, reply) => {
    const p = KundeParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await preislisteFuerKunde(db, p.data.kundeId, request.user.mandantId))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/preislisten', auth, async (request, reply) => {
    if (!darfLesen(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    return reply.send(await listePreislisten(db, request.user.mandantId))
  })

  fastify.post('/preislisten', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const b = PreislisteInputSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.status(201).send(await erstellePreisliste(db, request.user.mandantId, b.data))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/preislisten/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await holePreisliste(db, p.data.id, request.user.mandantId))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.put('/preislisten/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = PreislisteUpdateSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.send(await aktualisierePreisliste(db, p.data.id, request.user.mandantId, b.data))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.delete('/preislisten/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loeschePreisliste(db, p.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.put('/preislisten/:id/preise', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = PreislistePreiseSetzenSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.send(await setzePreise(db, p.data.id, request.user.mandantId, b.data))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.delete('/preislisten/:id/preise/:artikelId', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdArtikelParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await entfernePreis(db, p.data.id, request.user.mandantId, p.data.artikelId)
      return reply.status(204).send()
    } catch (err) { return fehlerAntwort(err, reply) }
  })
}
