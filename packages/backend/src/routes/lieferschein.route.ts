import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import {
  LiferscheinInputSchema,
  LiferscheinUpdateSchema,
  SammelrechnungInputSchema,
  type LiferscheinStatus,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { druckLog, mandanten } from '../db/schema.js'
import {
  listeLiferscheine,
  holeLiferschein,
  erstelleLiferschein,
  aktualisiereLiferschein,
  erstelleSammelrechnung,
  listeSammelrechnungen,
  holeSammelrechnung,
  LiferscheinError,
} from '../services/lieferschein.service.js'
import { resolveZielDrucker, sendBytes, DruckerError, type DruckerConfig } from '../services/drucker.service.js'
import { baueLieferscheinBon, baueRechnungBon, type BelegzweigPosition } from '../services/escpos/layout.js'
import { isEmailAktiv, sendeBelegzweigEmail } from '../services/email.service.js'

export interface LiferscheinRouteOptions { db: Db; config: Config }

const AusgabeBody = z.object({
  kasseId:   z.string().uuid(),
  druckerId: z.string().uuid().optional(),
})
const EmailBody = z.object({ empfaenger: z.string().trim().email() })

export const lieferscheinRoute: FastifyPluginAsync<LiferscheinRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  /** Firmenstammdaten für Bon-/Mail-Kopf */
  const firma = async (mandantId: string): Promise<{ firmenname?: string; uid?: string }> => {
    const [m] = await opts.db
      .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
      .from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
    return {
      ...(m?.firmenname ? { firmenname: m.firmenname } : {}),
      ...(m?.uid        ? { uid:        m.uid }        : {}),
    }
  }

  /** Ausgabe protokollieren + einheitliche Fehlerbehandlung */
  const druckeUndLogge = async (
    bytes:      Buffer,
    config:     DruckerConfig,
    mandantId:  string,
    kasseId:    string,
    druckerTyp: 'lieferschein' | 'rechnung',
  ): Promise<void> => {
    try {
      await sendBytes(bytes, config)
      await opts.db.insert(druckLog).values({
        mandantId, kasseId, druckerIp: config.ip, druckerTyp, erfolg: true,
      })
    } catch (err) {
      const meldung = err instanceof Error ? err.message : String(err)
      await opts.db.insert(druckLog).values({
        mandantId, kasseId, druckerIp: config.ip, druckerTyp, erfolg: false, fehlerText: meldung,
      })
      throw new DruckerError(502, `Druck fehlgeschlagen: ${meldung}`)
    }
  }

  const alsBonPositionen = (
    positionen: Array<{
      bezeichnung: string; menge: number; einzelpreisBreutto: number
      mwstSatz: string; seriennummern?: string[] | undefined
    }>,
  ): BelegzweigPosition[] =>
    positionen.map(p => ({
      bezeichnung:        p.bezeichnung,
      menge:              p.menge,
      einzelpreisBreutto: p.einzelpreisBreutto,
      mwstSatz:           p.mwstSatz as BelegzweigPosition['mwstSatz'],
      ...(p.seriennummern ? { seriennummern: p.seriennummern } : {}),
    }))

  // ---------------------------------------------------------------------------
  // Lieferscheine
  // ---------------------------------------------------------------------------

  fastify.get('/lieferscheine', auth, async (request, reply) => {
    const q         = request.query as Record<string, string>
    const kundeId   = q['kundeId']   as string | undefined
    const angebotId = q['angebotId'] as string | undefined
    const status    = q['status']    as LiferscheinStatus | undefined
    const liste     = await listeLiferscheine(opts.db, request.user.mandantId, {
      ...(kundeId   ? { kundeId }   : {}),
      ...(angebotId ? { angebotId } : {}),
      ...(status    ? { status }    : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 200,
    })
    return reply.send(liste)
  })

  fastify.get('/lieferscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeLiferschein(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/lieferscheine', auth, async (request, reply) => {
    const parsed = LiferscheinInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const ls = await erstelleLiferschein(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(ls)
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.patch('/lieferscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = LiferscheinUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await aktualisiereLiferschein(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---------------------------------------------------------------------------
  // Sammelrechnung
  // ---------------------------------------------------------------------------

  fastify.post('/sammelrechnungen', auth, async (request, reply) => {
    const parsed = SammelrechnungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const sr = await erstelleSammelrechnung(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(sr)
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Archiv: alle Sammelrechnungen (neueste zuerst) */
  fastify.get('/sammelrechnungen', auth, async (request, reply) => {
    const q = request.query as Record<string, string>
    return reply.send(await listeSammelrechnungen(opts.db, request.user.mandantId, {
      ...(q['kundeId'] ? { kundeId: q['kundeId'] } : {}),
      ...(q['limit']   ? { limit: parseInt(q['limit'], 10) } : {}),
    }))
  })

  fastify.get('/sammelrechnungen/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeSammelrechnung(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ---------------------------------------------------------------------------
  // Ausgabe: Bondruck + E-Mail (einheitlicher Ausgabe-Dialog)
  // ---------------------------------------------------------------------------

  fastify.post('/lieferscheine/:id/drucken', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = AusgabeBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      const ls     = await holeLiferschein(opts.db, id, request.user.mandantId)
      const config = await resolveZielDrucker(opts.db, request.user.mandantId, body.data.kasseId, body.data.druckerId)
      const bytes  = baueLieferscheinBon({
        breite: config.breite,
        ...(await firma(request.user.mandantId)),
        nummer: ls.nummer,
        datum:  ls.datum,
        angebotNummer: ls.angebotNummer,
        ...(ls.kunde ? { kunde: ls.kunde } : {}),
        positionen: alsBonPositionen(ls.positionen),
        ...(ls.notiz ? { notiz: ls.notiz } : {}),
      })
      await druckeUndLogge(bytes, config, request.user.mandantId, body.data.kasseId, 'lieferschein')
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      if (err instanceof DruckerError)     return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/lieferscheine/:id/email', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = EmailBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    if (!isEmailAktiv(opts.config)) {
      return reply.status(409).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP-Einstellungen fehlen)' })
    }
    try {
      const ls = await holeLiferschein(opts.db, id, request.user.mandantId)
      const f  = await firma(request.user.mandantId)
      await sendeBelegzweigEmail(body.data.empfaenger, {
        art:        'lieferschein',
        firmenname: f.firmenname ?? '',
        nummer:     ls.nummer,
        datum:      ls.datum,
        ...(ls.kunde?.bezeichnung ? { kundeName: ls.kunde.bezeichnung } : {}),
        positionen: ls.positionen.map(p => ({
          bezeichnung: p.bezeichnung, menge: p.menge, einzelpreisBreutto: p.einzelpreisBreutto,
        })),
      }, opts.config)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(502).send({ fehler: `E-Mail fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  fastify.post('/sammelrechnungen/:id/drucken', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = AusgabeBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    try {
      const sr     = await holeSammelrechnung(opts.db, id, request.user.mandantId)
      const config = await resolveZielDrucker(opts.db, request.user.mandantId, body.data.kasseId, body.data.druckerId)
      const bytes  = baueRechnungBon({
        breite: config.breite,
        ...(await firma(request.user.mandantId)),
        nummer: sr.nummer,
        datum:  sr.datum,
        ...(sr.kunde ? { kunde: sr.kunde } : {}),
        positionen: alsBonPositionen(sr.lieferscheine.flatMap(ls => ls.positionen)),
        lieferscheinNummern: sr.lieferscheine.map(ls => ls.nummer),
        gesamtbetragCent:    sr.gesamtbetragCent,
      })
      await druckeUndLogge(bytes, config, request.user.mandantId, body.data.kasseId, 'rechnung')
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      if (err instanceof DruckerError)     return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/sammelrechnungen/:id/email', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = EmailBody.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })
    if (!isEmailAktiv(opts.config)) {
      return reply.status(409).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP-Einstellungen fehlen)' })
    }
    try {
      const sr = await holeSammelrechnung(opts.db, id, request.user.mandantId)
      const f  = await firma(request.user.mandantId)
      await sendeBelegzweigEmail(body.data.empfaenger, {
        art:        'rechnung',
        firmenname: f.firmenname ?? '',
        nummer:     sr.nummer,
        datum:      sr.datum,
        ...(sr.kunde?.bezeichnung ? { kundeName: sr.kunde.bezeichnung } : {}),
        positionen: sr.lieferscheine.flatMap(ls => ls.positionen).map(p => ({
          bezeichnung: p.bezeichnung, menge: p.menge, einzelpreisBreutto: p.einzelpreisBreutto,
        })),
        gesamtbetragCent: sr.gesamtbetragCent,
      }, opts.config)
      return reply.send({ erfolgreich: true })
    } catch (err) {
      if (err instanceof LiferscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      return reply.status(502).send({ fehler: `E-Mail fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}
