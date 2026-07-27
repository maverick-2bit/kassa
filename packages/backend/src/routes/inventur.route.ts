/**
 * Inventur-Routen (Guard: authentifiziert + Berechtigung „artikel.verwalten").
 *
 *   POST   /api/inventuren                    Neue Inventur (Soll-Snapshot)
 *   GET    /api/inventuren                    Liste mit Zähl-Fortschritt
 *   GET    /api/inventuren/:id                Kopf + Positionen (Soll/Ist/Differenz)
 *   PATCH  /api/inventuren/:id/zaehlung       Gezählte Mengen erfassen (nur offen)
 *   POST   /api/inventuren/:id/abschliessen   Ist absolut auf den Lagerstand buchen
 *   DELETE /api/inventuren/:id                Offene Inventur verwerfen
 *   GET    /api/inventuren/:id/protokoll.csv  CSV-Protokoll (Download)
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { InventurAnlageSchema, InventurZaehlSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { druckLog, mandanten } from '../db/schema.js'
import {
  erstelleInventur,
  listeInventuren,
  holeInventur,
  erfasseZaehlung,
  schliesseInventurAb,
  loescheInventur,
  inventurProtokollCsv,
  InventurError,
} from '../services/inventur.service.js'
import { resolveZielDrucker, sendBytes, DruckerError } from '../services/drucker.service.js'
import { baueInventurBon } from '../services/escpos/layout.js'
import { isEmailAktiv, sendeInventurEmail } from '../services/email.service.js'

export interface InventurRouteOptions { db: Db; config: Config }

const IdParam = z.object({ id: z.string().uuid() })

export const inventurRoute: FastifyPluginAsync<InventurRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')

  fastify.post('/inventuren', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const b = InventurAnlageSchema.safeParse(request.body ?? {})
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      const res = await erstelleInventur(request.user.mandantId, request.user.name, b.data.bezeichnung, db)
      return reply.status(201).send(res)
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      request.log.error(err)
      return reply.status(500).send({ fehler: 'Inventur konnte nicht angelegt werden' })
    }
  })

  fastify.get('/inventuren', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    return reply.send(await listeInventuren(request.user.mandantId, db))
  })

  fastify.get('/inventuren/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await holeInventur(p.data.id, request.user.mandantId, db))
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/inventuren/:id/zaehlung', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = InventurZaehlSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      await erfasseZaehlung(p.data.id, request.user.mandantId, b.data.positionen, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/inventuren/:id/abschliessen', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      return reply.send(await schliesseInventurAb(p.data.id, request.user.mandantId, db))
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.delete('/inventuren/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheInventur(p.data.id, request.user.mandantId, db)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/inventuren/:id/protokoll.csv', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const { dateiname, csv } = await inventurProtokollCsv(p.data.id, request.user.mandantId, db)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${dateiname}"`)
        .send(csv)
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** POST /inventuren/:id/drucken — kompaktes Protokoll (nur Abweichungen) am Bondrucker */
  fastify.post('/inventuren/:id/drucken', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = z.object({
      kasseId:   z.string().uuid(),
      druckerId: z.string().uuid().optional(),
    }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const detail = await holeInventur(p.data.id, request.user.mandantId, db)
      const config = await resolveZielDrucker(db, request.user.mandantId, body.data.kasseId, body.data.druckerId)
      const gezaehlt = detail.positionen.filter(x => x.istMenge !== null)
      const bytes = baueInventurBon({
        breite:      config.breite,
        ...(await firmennameVon(db, request.user.mandantId)),
        bezeichnung: detail.bezeichnung,
        datum:       (detail.abgeschlossenAm ?? new Date()).toISOString(),
        erstelltVon: detail.erstelltVon,
        ...(detail.status === 'offen' ? { zwischenstand: true } : {}),
        abweichungen: gezaehlt
          .filter(x => (x.differenz ?? 0) !== 0)
          .map(x => ({ bezeichnung: x.bezeichnung, sollMenge: x.sollMenge, istMenge: x.istMenge! })),
        gesamtPositionen: detail.positionen.length,
        gezaehlt:         gezaehlt.length,
      })
      try {
        await sendBytes(bytes, config)
        await db.insert(druckLog).values({
          mandantId: request.user.mandantId, kasseId: body.data.kasseId,
          druckerIp: config.ip, druckerTyp: 'inventur', erfolg: true,
        })
      } catch (druckFehler) {
        const meldung = druckFehler instanceof Error ? druckFehler.message : String(druckFehler)
        await db.insert(druckLog).values({
          mandantId: request.user.mandantId, kasseId: body.data.kasseId,
          druckerIp: config.ip, druckerTyp: 'inventur', erfolg: false, fehlerText: meldung,
        })
        return reply.status(502).send({ fehler: `Druck fehlgeschlagen: ${meldung}` })
      }
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      if (err instanceof DruckerError)  return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(502).send({ fehler: `Druck fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  /** POST /inventuren/:id/email — Zusammenfassung + CSV-Anhang */
  fastify.post('/inventuren/:id/email', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const body = z.object({ empfaenger: z.string().trim().email() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    if (!isEmailAktiv(opts.config)) {
      return reply.status(409).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP-Einstellungen fehlen)' })
    }

    try {
      const detail = await holeInventur(p.data.id, request.user.mandantId, db)
      const { dateiname, csv } = await inventurProtokollCsv(p.data.id, request.user.mandantId, db)
      const gezaehlt = detail.positionen.filter(x => x.istMenge !== null)
      await sendeInventurEmail(body.data.empfaenger, {
        firmenname:       (await firmennameVon(db, request.user.mandantId)).firmenname ?? '',
        bezeichnung:      detail.bezeichnung,
        datum:            (detail.abgeschlossenAm ?? new Date()).toISOString(),
        erstelltVon:      detail.erstelltVon,
        gesamtPositionen: detail.positionen.length,
        gezaehlt:         gezaehlt.length,
        abweichungen:     gezaehlt.filter(x => (x.differenz ?? 0) !== 0).length,
        zwischenstand:    detail.status === 'offen',
        csvDateiname:     dateiname,
        csvInhalt:        csv,
      }, opts.config)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof InventurError) return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(502).send({ fehler: `E-Mail fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}

async function firmennameVon(db: Db, mandantId: string): Promise<{ firmenname?: string }> {
  const [m] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten)
    .where(eq(mandanten.id, mandantId)).limit(1)
  return m?.firmenname ? { firmenname: m.firmenname } : {}
}
