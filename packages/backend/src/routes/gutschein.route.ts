import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { GutscheinInputSchema, GutscheinEinloesenSchema, type GutscheinStatus } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { drucker, druckLog, kassen, mandanten } from '../db/schema.js'
import {
  listeGutscheine,
  listeGutscheinBuchungen,
  holeGutscheinById,
  holeGutscheinByCode,
  erstelleGutschein,
  loesGutscheinEin,
  storniereGutschein,
  holeGutscheinJournal,
  erstelleGutscheinJournalCsv,
  GutscheinError,
} from '../services/gutschein.service.js'
import { sendBytes, druckerConfigVonKasse } from '../services/drucker.service.js'
import { baueGutscheinBon } from '../services/escpos/layout.js'

export interface GutscheinRouteOptions { db: Db }

export const gutscheinRoute: FastifyPluginAsync<GutscheinRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  fastify.get('/gutscheine', auth, async (request, reply) => {
    const q       = request.query as Record<string, string>
    const status  = q['status']  as GutscheinStatus | undefined
    const kundeId = q['kundeId'] as string | undefined
    return reply.send(await listeGutscheine(opts.db, request.user.mandantId, {
      ...(status  ? { status  } : {}),
      ...(kundeId ? { kundeId } : {}),
      limit: q['limit'] ? parseInt(q['limit'], 10) : 500,
    }))
  })

  // ── Journal (Finanz): alle Bewegungen + tagesaktuelle Offen-Summe ─────────
  const JournalQuery = z.object({
    von: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })

  fastify.get('/gutscheine/journal', auth, async (request, reply) => {
    const q = JournalQuery.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'von/bis (YYYY-MM-DD) erforderlich' })
    try {
      return reply.send(await holeGutscheinJournal(opts.db, request.user.mandantId, q.data.von, q.data.bis))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/gutscheine/journal.csv', auth, async (request, reply) => {
    const q = JournalQuery.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: 'von/bis (YYYY-MM-DD) erforderlich' })
    try {
      const journal = await holeGutscheinJournal(opts.db, request.user.mandantId, q.data.von, q.data.bis)
      const csv = erstelleGutscheinJournalCsv(journal)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="gutschein-journal_${q.data.von}_${q.data.bis}.csv"`)
        .send(csv)
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Lookup per Code — für die Kasse */
  fastify.get('/gutscheine/code/:code', auth, async (request, reply) => {
    const { code } = request.params as { code: string }
    try {
      return reply.send(await holeGutscheinByCode(opts.db, code, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Transaktionshistorie eines Gutscheins */
  fastify.get('/gutscheine/:id/buchungen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await listeGutscheinBuchungen(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.get('/gutscheine/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await holeGutscheinById(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/gutscheine', auth, async (request, reply) => {
    const parsed = GutscheinInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      const gs = await erstelleGutschein(opts.db, request.user.mandantId, parsed.data)
      return reply.status(201).send(gs)
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  /** Einlösen — gibt { gutschein, restGutschein? } zurück */
  fastify.post('/gutscheine/:id/einloesen', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = GutscheinEinloesenSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    try {
      return reply.send(await loesGutscheinEin(opts.db, id, request.user.mandantId, parsed.data))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  fastify.post('/gutscheine/:id/stornieren', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send(await storniereGutschein(opts.db, id, request.user.mandantId))
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }
  })

  // ── Gutschein als ESC/POS-Bon drucken ──────────────────────────────────────
  // Zieldrucker: Kassen-Bondrucker der angegebenen Kasse (Beleg-Modus zählt hier
  // nicht — Gutschein ≠ Beleg, Muster Tisch-Etiketten) ODER ein Bibliotheks-Drucker.
  const GutscheinDruckSchema = z.object({
    kasseId:   z.string().uuid(),
    druckerId: z.string().uuid().optional(),
  })

  fastify.post('/gutscheine/:id/drucken', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = GutscheinDruckSchema.safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    let gs
    try {
      gs = await holeGutscheinById(opts.db, id, request.user.mandantId)
    } catch (err) {
      if (err instanceof GutscheinError) return reply.status(err.httpStatus).send({ fehler: err.message })
      throw err
    }

    const [kasse] = await opts.db.select().from(kassen).where(eq(kassen.id, body.data.kasseId)).limit(1)
    if (!kasse || kasse.mandantId !== request.user.mandantId)
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    let config = null as ReturnType<typeof druckerConfigVonKasse>
    if (body.data.druckerId) {
      const [d] = await opts.db.select().from(drucker).where(eq(drucker.id, body.data.druckerId)).limit(1)
      if (!d || d.mandantId !== request.user.mandantId) return reply.status(404).send({ fehler: 'Drucker nicht gefunden' })
      if (!d.aktiv) return reply.status(409).send({ fehler: 'Drucker ist deaktiviert' })
      config = { ip: d.ip, port: d.port, breite: d.breiteZeichen, timeoutMs: d.timeoutSek * 1000 }
    } else {
      config = druckerConfigVonKasse(kasse, { ignoreBelegModus: true })
    }
    if (!config) return reply.status(409).send({ fehler: 'Drucker nicht konfiguriert oder deaktiviert' })

    const [mandant] = await opts.db
      .select({ firmenname: mandanten.firmenname })
      .from(mandanten)
      .where(eq(mandanten.id, request.user.mandantId))
      .limit(1)

    const bytes = baueGutscheinBon({
      breite:     config.breite,
      ...(mandant?.firmenname ? { firmenname: mandant.firmenname } : {}),
      code:       gs.code,
      nummer:     gs.nummer,
      datum:      typeof gs.datum === 'string' ? gs.datum : new Date(gs.datum).toISOString(),
      betragCent: gs.betragCent,
      restCent:   gs.restCent,
      gueltigBis: gs.gueltigBis ?? null,
    })

    try {
      await sendBytes(bytes, config)
      await opts.db.insert(druckLog).values({
        mandantId:  request.user.mandantId,
        kasseId:    kasse.id,
        druckerIp:  config.ip,
        druckerTyp: 'gutschein',
        erfolg:     true,
      })
      return reply.send({ erfolgreich: true })
    } catch (err) {
      const meldung = err instanceof Error ? err.message : String(err)
      await opts.db.insert(druckLog).values({
        mandantId:  request.user.mandantId,
        kasseId:    kasse.id,
        druckerIp:  config.ip,
        druckerTyp: 'gutschein',
        erfolg:     false,
        fehlerText: meldung,
      })
      return reply.status(502).send({ fehler: `Druck fehlgeschlagen: ${meldung}` })
    }
  })
}
