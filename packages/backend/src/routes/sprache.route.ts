/**
 * Sprachbestellung (optionales Modul `modulSpracheAktiv`).
 *
 * Bestellung:
 *   POST /api/sprache/bestellung               Text rein → Vorschläge + Vorlesetext raus (bucht NICHT)
 *                                              (Berechtigung „tische" oder „kasse" bzw. Admin)
 * Synonyme (Pflege):
 *   GET  /api/sprache/synonyme                 alle Artikel mit Synonymen
 *   GET  /api/sprache/artikel/:id/synonyme     Synonyme eines Artikels
 *   PUT  /api/sprache/artikel/:id/synonyme     Synonyme eines Artikels ersetzen (meldet Konflikte)
 *                                              (Berechtigung „artikel.verwalten" bzw. Admin)
 *
 * Alles nur bei aktivem Modul (sonst 403); mandantId immer aus dem Login. Die Vorschläge landen nach
 * Bestätigung im normalen Korb der Kellner-App — Bonierung, Preise und RKSV bleiben unberührt.
 *
 * Mandanten ohne Modul zahlen nichts dafür: Parser und Katalog-Cache werden erst beim ersten Satz eines
 * Betriebs MIT Modul geladen (dynamischer Import), der Katalog-Index erst dann gebaut. Neue oder
 * umbenannte Artikel erkennt die Sprache nach spätestens 30 s, geänderte Synonyme sofort.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtikelSynonymeSetzenSchema, SpracheBestellungInputSchema, type SpracheBestellungErgebnis } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  holeSynonyme, ladeSprachArtikel, listeSynonyme, pruefeSpracheModul, setzeSynonyme, SpracheError,
} from '../services/sprache.service.js'
import type { KatalogCache } from '../services/sprache/index.js'

export interface SpracheRouteOptions { db: Db }

const IdParam = z.object({ id: z.string().guid() })

export const spracheRoute: FastifyPluginAsync<SpracheRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')
  const darfBestellen = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('tische') || request.user.berechtigungen.includes('kasse')

  const fehlerAntwort = (err: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof SpracheError) return reply.status(err.httpStatus).send({ fehler: err.message })
    throw err
  }

  // Parser + Katalog-Cache erst beim ersten Bedarf laden (Betriebe ohne Modul berühren das nie)
  let werkzeug: Promise<{ parse: typeof import('../services/sprache/index.js'); cache: KatalogCache }> | null = null
  const holeWerkzeug = () => (werkzeug ??= import('../services/sprache/index.js').then(parse => ({
    parse,
    cache: new parse.KatalogCache({
      lade: async (mandantId) => parse.baueKatalog(await ladeSprachArtikel(db, mandantId)),
    }),
  })))

  fastify.post('/sprache/bestellung', auth, async (request, reply) => {
    if (!darfBestellen(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const b = SpracheBestellungInputSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      const { parse, cache } = await holeWerkzeug()
      const katalog = await cache.holen(request.user.mandantId)
      const ergebnis = parse.parseBestellung(katalog, b.data.text)
      const antwort: SpracheBestellungErgebnis = { ...ergebnis, vorlesetext: parse.leseVor(ergebnis) }
      return reply.send(antwort)
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/sprache/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      return reply.send(await listeSynonyme(db, request.user.mandantId))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/sprache/artikel/:id/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      return reply.send(await holeSynonyme(db, request.user.mandantId, p.data.id))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.put('/sprache/artikel/:id/synonyme', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = ArtikelSynonymeSetzenSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      await pruefeSpracheModul(db, request.user.mandantId)
      const ergebnis = await setzeSynonyme(db, request.user.mandantId, p.data.id, b.data.synonyme)
      // Geänderte Synonyme sofort wirksam: Katalog dieses Betriebs verwerfen (nur falls schon geladen)
      if (werkzeug) (await werkzeug).cache.verwerfen(request.user.mandantId)
      return reply.send(ergebnis)
    } catch (err) { return fehlerAntwort(err, reply) }
  })
}
