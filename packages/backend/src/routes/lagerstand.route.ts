import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { LagerstandBulkInputSchema } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { druckLog, mandanten } from '../db/schema.js'
import { bulkLagerstandAktualisieren } from '../services/lagerstand.service.js'
import { resolveZielDrucker, sendBytes, DruckerError } from '../services/drucker.service.js'
import { baueWareneingangBon } from '../services/escpos/layout.js'
import { isEmailAktiv, sendeWareneingangEmail } from '../services/email.service.js'

export interface LagerstandRouteOptions {
  db:     Db
  config: Config
}

const WareneingangPositionen = z.array(z.object({
  bezeichnung: z.string().trim().min(1).max(120),
  menge:       z.number().positive(),
})).min(1).max(500)

export const lagerstandRoute: FastifyPluginAsync<LagerstandRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  /**
   * POST /lagerstand/bulk
   * Bulk-Aktualisierung für Wareneingang (addieren) oder Inventur (absolut setzen).
   */
  fastify.post('/lagerstand/bulk', auth, async (request, reply) => {
    const parsed = LagerstandBulkInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    await bulkLagerstandAktualisieren(parsed.data, request.user.mandantId, db)
    return reply.status(204).send()
  })

  /**
   * POST /lagerstand/wareneingang-ausgabe — Bon des soeben erfassten Eingangs
   * (Wareneingänge haben keine Historie; die Positionsliste liefert der Client).
   */
  fastify.post('/lagerstand/wareneingang-ausgabe', auth, async (request, reply) => {
    const body = z.object({
      kasseId:    z.string().uuid(),
      druckerId:  z.string().uuid().optional(),
      lieferant:  z.string().trim().max(120).optional(),
      positionen: WareneingangPositionen,
    }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    try {
      const config = await resolveZielDrucker(db, request.user.mandantId, body.data.kasseId, body.data.druckerId)
      const bytes = baueWareneingangBon({
        breite:     config.breite,
        ...(await firmenname(db, request.user.mandantId)),
        ...(body.data.lieferant ? { lieferant: body.data.lieferant } : {}),
        datum:      new Date().toISOString(),
        erfasstVon: request.user.name,
        positionen: body.data.positionen,
      })
      try {
        await sendBytes(bytes, config)
        await db.insert(druckLog).values({
          mandantId: request.user.mandantId, kasseId: body.data.kasseId,
          druckerIp: config.ip, druckerTyp: 'wareneingang', erfolg: true,
        })
      } catch (druckFehler) {
        const meldung = druckFehler instanceof Error ? druckFehler.message : String(druckFehler)
        await db.insert(druckLog).values({
          mandantId: request.user.mandantId, kasseId: body.data.kasseId,
          druckerIp: config.ip, druckerTyp: 'wareneingang', erfolg: false, fehlerText: meldung,
        })
        return reply.status(502).send({ fehler: `Druck fehlgeschlagen: ${meldung}` })
      }
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof DruckerError) return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(502).send({ fehler: `Druck fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  /** POST /lagerstand/wareneingang-email — Positionsliste per Mail */
  fastify.post('/lagerstand/wareneingang-email', auth, async (request, reply) => {
    const body = z.object({
      empfaenger: z.string().trim().email(),
      lieferant:  z.string().trim().max(120).optional(),
      positionen: WareneingangPositionen,
    }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    if (!isEmailAktiv(opts.config)) {
      return reply.status(409).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP-Einstellungen fehlen)' })
    }
    try {
      await sendeWareneingangEmail(body.data.empfaenger, {
        firmenname: (await firmenname(db, request.user.mandantId)).firmenname ?? '',
        lieferant:  body.data.lieferant,
        datum:      new Date().toISOString(),
        erfasstVon: request.user.name,
        positionen: body.data.positionen,
      }, opts.config)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      return reply.status(502).send({ fehler: `E-Mail fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}

async function firmenname(db: Db, mandantId: string): Promise<{ firmenname?: string }> {
  const [m] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten)
    .where(eq(mandanten.id, mandantId)).limit(1)
  return m?.firmenname ? { firmenname: m.firmenname } : {}
}
