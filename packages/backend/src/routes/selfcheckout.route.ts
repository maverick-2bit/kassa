/**
 * Self-Checkout-Routen (öffentlich — kein JWT)
 *
 *  GET  /api/selfcheckout?kasseId=&tisch=
 *    → Offener Tab des Tisches anzeigen
 *
 *  POST /api/selfcheckout/zahlung-anfordern
 *    → Gast fordert Zahlung an → SSE-Event an Kellner
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, tischTabs } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'

export interface SelfCheckoutRouteOptions { db: Db }

const TabQuerySchema = z.object({
  kasseId: z.string().uuid(),
  tisch:   z.string().min(1).max(40),
})

const ZahlungAnfordernSchema = z.object({
  kasseId: z.string().uuid(),
  tisch:   z.string().min(1).max(40),
})

interface TabPosition {
  bezeichnung:      string
  menge:            number
  preisBruttoCent:  number
}

export const selfcheckoutRoute: FastifyPluginAsync<SelfCheckoutRouteOptions> = async (fastify, opts) => {
  // ---- GET /selfcheckout ----
  fastify.get('/selfcheckout', async (request, reply) => {
    const q = TabQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'Ungültige Parameter' })

    const [kasse] = await opts.db
      .select({ id: kassen.id, mandantId: kassen.mandantId, kassenId: kassen.kassenId, selfCheckoutAktiv: kassen.selfCheckoutAktiv })
      .from(kassen)
      .where(eq(kassen.id, q.data.kasseId))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    if (!kasse.selfCheckoutAktiv) return reply.status(403).send({ fehler: 'Self-Checkout ist für diese Kasse nicht aktiviert' })

    const [tab] = await opts.db
      .select()
      .from(tischTabs)
      .where(and(
        eq(tischTabs.kasseId, q.data.kasseId),
        eq(tischTabs.tischNummer, q.data.tisch),
        eq(tischTabs.status, 'offen'),
      ))
      .limit(1)

    if (!tab) {
      return reply.send({ tisch: q.data.tisch, offen: false, positionen: [], summeCent: 0 })
    }

    const positionen = (tab.positionen as TabPosition[]) ?? []
    const summeCent  = positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)

    return reply.send({
      tabId:     tab.id,
      tisch:     tab.tischNummer,
      kellner:   tab.kellner,
      offen:     true,
      positionen: positionen.map(p => ({
        bezeichnung:    p.bezeichnung,
        menge:          p.menge,
        preisCent:      p.preisBruttoCent,
        gesamtCent:     p.preisBruttoCent * p.menge,
      })),
      summeCent,
      geoffnetAm: tab.geoffnetAm.toISOString(),
    })
  })

  // ---- POST /selfcheckout/zahlung-anfordern ----
  fastify.post('/selfcheckout/zahlung-anfordern', async (request, reply) => {
    const body = ZahlungAnfordernSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const [kasse] = await opts.db
      .select({ id: kassen.id, mandantId: kassen.mandantId, selfCheckoutAktiv: kassen.selfCheckoutAktiv })
      .from(kassen)
      .where(eq(kassen.id, body.data.kasseId))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    if (!kasse.selfCheckoutAktiv) return reply.status(403).send({ fehler: 'Self-Checkout nicht aktiviert' })

    const [tab] = await opts.db
      .select()
      .from(tischTabs)
      .where(and(
        eq(tischTabs.kasseId, body.data.kasseId),
        eq(tischTabs.tischNummer, body.data.tisch),
        eq(tischTabs.status, 'offen'),
      ))
      .limit(1)

    if (!tab) return reply.status(404).send({ fehler: 'Kein offener Tisch gefunden' })

    const positionen = (tab.positionen as TabPosition[]) ?? []
    const summeCent  = positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)

    emitKasseEvent(kasse.mandantId, {
      typ:         'zahlung_angefordert',
      kasseId:     body.data.kasseId,
      tischNummer: body.data.tisch,
      tabId:       tab.id,
      summeCent,
    })

    return reply.send({ erfolgreich: true, summeCent })
  })
}
