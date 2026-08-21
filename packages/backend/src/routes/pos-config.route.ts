/**
 * POS-Konfiguration pro Kasse.
 *   GET   /api/kassen/:kasseId/pos-config         Konfiguration lesen
 *   PUT   /api/kassen/:kasseId/pos-config         Konfiguration schreiben
 *   PATCH /api/artikel/reihenfolge                Globale Artikel-Reihenfolge (Bulk)
 *   PATCH /api/artikel/favoriten-reihenfolge      Globale Favoriten-Reihenfolge (Bulk)
 *   PATCH /api/kategorien/reihenfolge             Globale Kategorie-Reihenfolge (Bulk)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ReihenfolgeUpdateSchema, FavoritenReihenfolgeUpdateSchema } from '@kassa/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { KasseFavoritenUpdateSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, kassekategorieSichtbarkeit, kasseBonierdruckerSichtbarkeit, kasseFavoriten, artikel, kategorien } from '../db/schema.js'

export interface PosConfigRouteOptions { db: Db }

const KasseIdParam = z.object({ kasseId: z.string().uuid() })

const StartseitenEnum      = z.enum(['tische', 'kasse', 'kasse_favoriten', 'dashboard'])
const KellnerTischwahlEnum = z.enum(['manuell', 'liste', 'plan'])
const KellnerModusEnum     = z.enum(['tische', 'theke'])

const PosConfigBodySchema = z.object({
  sichtbareKategorieIds:     z.array(z.string().uuid()).optional(),
  sichtbareBonierdruckerIds: z.array(z.string().uuid()).optional(),
  erlaubteZahlungsarten: z.array(z.enum(['bar', 'karte', 'sonstige'])).optional(),
  artikelbilderAktiv:    z.boolean().optional(),
  artikelProZeile:       z.number().int().min(2).max(6).optional(),
  startseite:            StartseitenEnum.optional(),
  kellnerModus:          KellnerModusEnum.optional(),
  kellnerTischwahl:      KellnerTischwahlEnum.optional(),
  kellnerFavoritenAktiv: z.boolean().optional(),
})

export const posConfigRoute: FastifyPluginAsync<PosConfigRouteOptions> = async (fastify, opts) => {

  // ---- GET /kassen/:kasseId/pos-config ----
  fastify.get('/kassen/:kasseId/pos-config', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const [kasse] = await opts.db
      .select({
        erlaubteZahlungsarten: kassen.erlaubteZahlungsarten,
        artikelbilderAktiv:    kassen.artikelbilderAktiv,
        artikelProZeile:       kassen.artikelProZeile,
        startseite:            kassen.startseite,
        kellnerModus:          kassen.kellnerModus,
        kellnerTischwahl:      kassen.kellnerTischwahl,
        kellnerFavoritenAktiv: kassen.kellnerFavoritenAktiv,
      })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const sichtbarkeit = await opts.db
      .select({ kategorieId: kassekategorieSichtbarkeit.kategorieId })
      .from(kassekategorieSichtbarkeit)
      .where(eq(kassekategorieSichtbarkeit.kasseId, p.data.kasseId))

    const bonierdruckerSicht = await opts.db
      .select({ bonierdruckerId: kasseBonierdruckerSichtbarkeit.bonierdruckerId })
      .from(kasseBonierdruckerSichtbarkeit)
      .where(eq(kasseBonierdruckerSichtbarkeit.kasseId, p.data.kasseId))

    return reply.send({
      sichtbareKategorieIds:     sichtbarkeit.map(r => r.kategorieId),
      sichtbareBonierdruckerIds: bonierdruckerSicht.map(r => r.bonierdruckerId),
      erlaubteZahlungsarten: kasse.erlaubteZahlungsarten as string[],
      artikelbilderAktiv:    kasse.artikelbilderAktiv,
      artikelProZeile:       kasse.artikelProZeile,
      startseite:            kasse.startseite,
      kellnerModus:          kasse.kellnerModus,
      kellnerTischwahl:      kasse.kellnerTischwahl,
      kellnerFavoritenAktiv: kasse.kellnerFavoritenAktiv,
    })
  })

  // ---- PUT /kassen/:kasseId/pos-config ----
  fastify.put('/kassen/:kasseId/pos-config', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const body = PosConfigBodySchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [kasse] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    await opts.db.transaction(async (tx) => {
      // Zahlungsarten + Darstellungsoptionen + Startseite
      const kassenPatch = {
        ...(body.data.erlaubteZahlungsarten !== undefined && { erlaubteZahlungsarten: body.data.erlaubteZahlungsarten }),
        ...(body.data.artikelbilderAktiv    !== undefined && { artikelbilderAktiv:    body.data.artikelbilderAktiv }),
        ...(body.data.artikelProZeile       !== undefined && { artikelProZeile:       body.data.artikelProZeile }),
        ...(body.data.startseite            !== undefined && { startseite:            body.data.startseite }),
        ...(body.data.kellnerModus          !== undefined && { kellnerModus:          body.data.kellnerModus }),
        ...(body.data.kellnerTischwahl      !== undefined && { kellnerTischwahl:      body.data.kellnerTischwahl }),
        ...(body.data.kellnerFavoritenAktiv !== undefined && { kellnerFavoritenAktiv: body.data.kellnerFavoritenAktiv }),
      }
      if (Object.keys(kassenPatch).length > 0) {
        await tx.update(kassen)
          .set({ ...kassenPatch, updatedAt: new Date() })
          .where(eq(kassen.id, p.data.kasseId))
      }

      // Kategorie-Sichtbarkeit komplett ersetzen
      if (body.data.sichtbareKategorieIds !== undefined) {
        await tx.delete(kassekategorieSichtbarkeit)
          .where(eq(kassekategorieSichtbarkeit.kasseId, p.data.kasseId))

        if (body.data.sichtbareKategorieIds.length > 0) {
          await tx.insert(kassekategorieSichtbarkeit).values(
            body.data.sichtbareKategorieIds.map(kategorieId => ({
              kasseId: p.data.kasseId,
              kategorieId,
            }))
          )
        }
      }

      // Bonierdrucker-Sichtbarkeit komplett ersetzen (leer = alle)
      if (body.data.sichtbareBonierdruckerIds !== undefined) {
        await tx.delete(kasseBonierdruckerSichtbarkeit)
          .where(eq(kasseBonierdruckerSichtbarkeit.kasseId, p.data.kasseId))

        if (body.data.sichtbareBonierdruckerIds.length > 0) {
          await tx.insert(kasseBonierdruckerSichtbarkeit).values(
            body.data.sichtbareBonierdruckerIds.map(bonierdruckerId => ({
              kasseId: p.data.kasseId,
              bonierdruckerId,
            }))
          )
        }
      }
    })

    return reply.status(204).send()
  })

  // ---- Favoriten je Kasse (artikelId null = Platzhalter) ----
  fastify.get('/kassen/:kasseId/favoriten', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })

    const rows = await opts.db
      .select({ artikelId: kasseFavoriten.artikelId })
      .from(kasseFavoriten)
      .innerJoin(kassen, eq(kassen.id, kasseFavoriten.kasseId))
      .where(and(eq(kasseFavoriten.kasseId, p.data.kasseId), eq(kassen.mandantId, request.user.mandantId)))
      .orderBy(asc(kasseFavoriten.position))
    return reply.send({ eintraege: rows })
  })

  fastify.put('/kassen/:kasseId/favoriten', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const p = KasseIdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Kassen-ID' })
    const body = KasseFavoritenUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const mandantId = request.user.mandantId
    const [kasse] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, p.data.kasseId), eq(kassen.mandantId, mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    // Artikel-IDs müssen dem Mandanten gehören (Platzhalter = null sind frei)
    const artikelIds = [...new Set(body.data.eintraege.map(e => e.artikelId).filter((id): id is string => id !== null))]
    if (artikelIds.length > 0) {
      const bekannt = await opts.db
        .select({ id: artikel.id })
        .from(artikel)
        .where(and(inArray(artikel.id, artikelIds), eq(artikel.mandantId, mandantId)))
      if (bekannt.length !== artikelIds.length) {
        return reply.status(400).send({ fehler: 'Unbekannte Artikel-ID in den Favoriten' })
      }
    }

    await opts.db.transaction(async (tx) => {
      await tx.delete(kasseFavoriten).where(eq(kasseFavoriten.kasseId, p.data.kasseId))
      if (body.data.eintraege.length > 0) {
        await tx.insert(kasseFavoriten).values(
          body.data.eintraege.map((e, i) => ({
            mandantId,
            kasseId:   p.data.kasseId,
            position:  i,
            artikelId: e.artikelId,
          })),
        )
      }
    })
    return reply.status(204).send()
  })

  // ---- PATCH /artikel/reihenfolge ----
  fastify.patch('/artikel/reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, reihenfolge } of parsed.data.eintraege) {
        await tx.update(artikel)
          .set({ reihenfolge, updatedAt: new Date() })
          .where(and(eq(artikel.id, id), eq(artikel.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })

  // ---- PATCH /artikel/favoriten-reihenfolge ----
  fastify.patch('/artikel/favoriten-reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = FavoritenReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, favoritenReihenfolge } of parsed.data.eintraege) {
        await tx.update(artikel)
          .set({ favoritenReihenfolge, updatedAt: new Date() })
          .where(and(eq(artikel.id, id), eq(artikel.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })

  // ---- PATCH /kategorien/reihenfolge ----
  fastify.patch('/kategorien/reihenfolge', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ReihenfolgeUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    await opts.db.transaction(async (tx) => {
      for (const { id, reihenfolge } of parsed.data.eintraege) {
        await tx.update(kategorien)
          .set({ reihenfolge, updatedAt: new Date() })
          .where(and(eq(kategorien.id, id), eq(kategorien.mandantId, mandantId)))
      }
    })
    return reply.status(204).send()
  })
}
