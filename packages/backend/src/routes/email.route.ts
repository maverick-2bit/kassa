/**
 * E-Mail-Route: POST /api/belege/:id/email
 *
 * Versendet einen signierten Beleg als HTML-E-Mail an eine angegebene Adresse.
 * Erfordert SMTP_HOST/SMTP_USER/SMTP_PASS in der Konfiguration.
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { belege, kassen, mandanten } from '../db/schema.js'
import { isEmailAktiv, sendeBelegEmail } from '../services/email.service.js'

export interface EmailRouteOptions { db: Db; config: Config }

const IdParam    = z.object({ id: z.string().uuid() })
const EmailBody  = z.object({
  empfaenger: z.string().email('Ungültige E-Mail-Adresse'),
})

export const emailRoute: FastifyPluginAsync<EmailRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.post('/belege/:id/email', guard, async (request, reply) => {
    if (!isEmailAktiv(opts.config)) {
      return reply.status(503).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP_HOST fehlt)' })
    }

    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige Beleg-ID' })

    const b = EmailBody.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })

    // Beleg laden + Mandant-Check
    const [beleg] = await opts.db
      .select()
      .from(belege)
      .where(and(eq(belege.id, p.data.id), eq(belege.mandantId, request.user.mandantId)))
      .limit(1)

    if (!beleg) return reply.status(404).send({ fehler: 'Beleg nicht gefunden' })

    // Kasse + Mandant laden (für Firmenname und UID)
    const [kasse] = await opts.db
      .select({ kassenId: kassen.kassenId })
      .from(kassen)
      .where(eq(kassen.id, beleg.kasseId))
      .limit(1)

    const [mandant] = await opts.db
      .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
      .from(mandanten)
      .where(eq(mandanten.id, beleg.mandantId))
      .limit(1)

    if (!mandant) return reply.status(500).send({ fehler: 'Mandant nicht gefunden' })

    const positionen = (beleg.positionen as Array<{
      bezeichnung:     string
      menge:           number
      preisBruttoCent: number
      mwstSatz:        string
    }>)

    const summeCent =
      (beleg.summeBarCent ?? 0) +
      (beleg.summeKarteCent ?? 0) +
      (beleg.summeSonstigeCent ?? 0)

    try {
      await sendeBelegEmail(
        b.data.empfaenger,
        {
          belegNummer:  beleg.belegNummer,
          belegDatum:   beleg.belegDatum.toISOString(),
          firmenname:   mandant.firmenname,
          uid:          mandant.uid,
          positionen,
          summeCent,
          signaturwert: beleg.signaturwert,
        },
        opts.config,
      )
      return reply.send({ erfolgreich: true })
    } catch (err) {
      fastify.log.error({ err }, 'E-Mail-Versand fehlgeschlagen')
      return reply.status(502).send({
        fehler: `E-Mail konnte nicht gesendet werden: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })
}
