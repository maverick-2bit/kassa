import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  ModifikatorGruppeErstellenSchema,
  ModifikatorGruppeAktualisierenSchema,
  ModifikatorErstellenSchema,
  ModifikatorAktualisierenSchema,
  ArtikelGruppenZuweisungSchema,
} from '@kassa/shared'
import {
  listeGruppen,
  listeArtikelGruppenZuweisungen,
  erstelleGruppe,
  aktualisiereGruppe,
  loescheGruppe,
  erstelleModifikator,
  aktualisiereModifikator,
  loescheModifikator,
  getGruppenFuerArtikel,
  setzeGruppenFuerArtikel,
  ModifikatorError,
} from '../services/modifikator.service.js'
import type { Db } from '../db/client.js'

export interface ModifikatorRouteOptions {
  db: Db
}

const IdParam        = z.object({ id: z.string().uuid() })
const GruppeIdParam  = z.object({ gruppeId: z.string().uuid() })
const ArtikelIdParam = z.object({ artikelId: z.string().uuid() })

export const modifikatorRoute: FastifyPluginAsync<ModifikatorRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  // -------------------------------------------------------------------------
  // Gruppen
  // -------------------------------------------------------------------------

  fastify.get('/modifikator-gruppen', auth, async (request, reply) => {
    const gruppen = await listeGruppen(request.user.mandantId, db)
    return reply.send(gruppen)
  })

  fastify.post('/modifikator-gruppen', auth, async (request, reply) => {
    const parsed = ModifikatorGruppeErstellenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gruppe = await erstelleGruppe(parsed.data, request.user.mandantId, db)
      return reply.status(201).send(gruppe)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/modifikator-gruppen/:id', auth, async (request, reply) => {
    const params = IdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { id } = params.data
    const parsed = ModifikatorGruppeAktualisierenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gruppe = await aktualisiereGruppe(id, parsed.data, request.user.mandantId, db)
      return reply.send(gruppe)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/modifikator-gruppen/:id', auth, async (request, reply) => {
    const params = IdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { id } = params.data
    try {
      await loescheGruppe(id, request.user.mandantId, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // Modifikatoren (innerhalb einer Gruppe)
  // -------------------------------------------------------------------------

  fastify.post('/modifikator-gruppen/:gruppeId/modifikatoren', auth, async (request, reply) => {
    const params = GruppeIdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { gruppeId } = params.data
    const parsed = ModifikatorErstellenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gruppe = await erstelleModifikator(gruppeId, parsed.data, request.user.mandantId, db)
      return reply.status(201).send(gruppe)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/modifikatoren/:id', auth, async (request, reply) => {
    const params = IdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { id } = params.data
    const parsed = ModifikatorAktualisierenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gruppe = await aktualisiereModifikator(id, parsed.data, request.user.mandantId, db)
      return reply.send(gruppe)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/modifikatoren/:id', auth, async (request, reply) => {
    const params = IdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { id } = params.data
    try {
      await loescheModifikator(id, request.user.mandantId, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // Bulk: alle Artikel-Gruppen-Zuweisungen für den Mandanten
  fastify.get('/artikel-modifikator-gruppen', auth, async (request, reply) => {
    const zuweisungen = await listeArtikelGruppenZuweisungen(request.user.mandantId, db)
    return reply.send(zuweisungen)
  })

  // -------------------------------------------------------------------------
  // Artikel ↔ Gruppen
  // -------------------------------------------------------------------------

  fastify.get('/artikel/:artikelId/modifikator-gruppen', auth, async (request, reply) => {
    const params = ArtikelIdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { artikelId } = params.data
    try {
      const gruppen = await getGruppenFuerArtikel(artikelId, request.user.mandantId, db)
      return reply.send(gruppen)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.put('/artikel/:artikelId/modifikator-gruppen', auth, async (request, reply) => {
    const params = ArtikelIdParam.safeParse(request.params)
    if (!params.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const { artikelId } = params.data
    const parsed = ArtikelGruppenZuweisungSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gruppen = await setzeGruppenFuerArtikel(artikelId, parsed.data, request.user.mandantId, db)
      return reply.send(gruppen)
    } catch (err) {
      if (err instanceof ModifikatorError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })
}
