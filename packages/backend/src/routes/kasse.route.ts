/**
 * Kassen-Informationen (Status, Zertifikats-Ablauf, Jahresbeleg-Fälligkeit).
 */

import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen } from '../db/schema.js'
import { KasseBezeichnungUpdateSchema } from '@kassa/shared'

export interface KasseRouteOptions { db: Db }

const MS_PRO_TAG = 1000 * 60 * 60 * 24

export const kasseRoute: FastifyPluginAsync<KasseRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  /**
   * GET /kassen/:id/status
   * Ablauf-Datum des SEE-Zertifikats — Frontend kann rechtzeitig warnen.
   */
  fastify.get('/kassen/:id/status', auth, async (request, reply) => {
    const { id }      = request.params as { id: string }
    const mandantId   = request.user.mandantId

    const [kasse] = await opts.db
      .select({
        id:              kassen.id,
        kassenId:        kassen.kassenId,
        bezeichnung:     kassen.bezeichnung,
        seeGueltigBis:   kassen.seeGueltigBis,
        beiFoRegistriert: kassen.bei_fo_registriert,
        status:          kassen.status,
      })
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, mandantId)))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const now          = new Date()
    const restMs       = kasse.seeGueltigBis.getTime() - now.getTime()
    const restTage     = Math.floor(restMs / MS_PRO_TAG)
    const abgelaufen   = restMs <= 0

    return reply.send({
      kasseId:         kasse.kassenId,
      bezeichnung:     kasse.bezeichnung,
      status:          kasse.status,
      seeGueltigBis:   kasse.seeGueltigBis.toISOString(),
      seeRestTage:     Math.max(0, restTage),
      seeAbgelaufen:   abgelaufen,
    })
  })

  /**
   * GET /kassen/:kasseId/jahresbeleg-status
   *
   * Prüft, ob für die Kasse bereits ein Jahresbeleg im aktuellen Kalenderjahr
   * (Wiener Ortszeit) erstellt wurde.  Wird vom Frontend für den
   * Jahresbeleg-Fälligkeits-Banner verwendet.
   */
  fastify.get('/kassen/:kasseId/jahresbeleg-status', auth, async (request, reply) => {
    const { kasseId } = request.params as { kasseId: string }
    const mandantId   = request.user.mandantId

    // Ownership-Check
    const [kasse] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    // Aktuelles Jahr in Wiener Ortszeit (UTC+1/+2 — Differenz zum Jahr irrelevant)
    const aktuellesJahr = new Date().getFullYear()

    // Jüngsten Jahresbeleg im laufenden Kalenderjahr suchen
    const rows = await opts.db
      .select({ id: belege.id, belegDatum: belege.belegDatum })
      .from(belege)
      .where(and(
        eq(belege.kasseId, kasseId),
        eq(belege.belegTyp, 'Jahresbeleg'),
        sql`EXTRACT(YEAR FROM (${belege.belegDatum} AT TIME ZONE 'Europe/Vienna')) = ${aktuellesJahr}`,
      ))
      .orderBy(desc(belege.belegDatum))
      .limit(1)

    const letzter = rows[0] ?? null

    return reply.send({
      jahr:                   aktuellesJahr,
      jahresbelegFaellig:     letzter === null,
      jahresbelegErstelltAm:  letzter?.belegDatum.toISOString() ?? null,
    })
  })

  /**
   * PATCH /kassen/:id/bezeichnung
   * Kassenbezeichnung (Anzeigename) aktualisieren.
   */
  fastify.patch('/kassen/:id/bezeichnung', auth, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const { id } = request.params as { id: string }

    const body = KasseBezeichnungUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    // Ownership-Check
    const [check] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!check) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [updated] = await opts.db
      .update(kassen)
      .set({ bezeichnung: body.data.bezeichnung })
      .where(eq(kassen.id, id))
      .returning({ id: kassen.id, bezeichnung: kassen.bezeichnung })

    return reply.send(updated)
  })
}
