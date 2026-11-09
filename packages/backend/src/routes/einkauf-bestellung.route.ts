/**
 * Einkaufsbestellungen (Bestellung beim Lieferanten)
 *
 *   GET    /einkauf/bestellungen              Liste (?status=&lieferantId=)
 *   POST   /einkauf/bestellungen              anlegen (Entwurf)
 *   GET    /einkauf/bestellungen/:id          Detail mit Positionen
 *   PUT    /einkauf/bestellungen/:id          bearbeiten (nur Entwurf)
 *   DELETE /einkauf/bestellungen/:id          löschen (nur Entwurf)
 *   POST   /einkauf/bestellungen/:id/status   Statuswechsel { status }
 *   GET    /einkauf/bestellungen/:id/pdf      Bestell-PDF
 *   POST   /einkauf/bestellungen/:id/email    PDF per Mail an den Lieferanten, setzt „gesendet"
 *
 * Alles nur mit Berechtigung „artikel.verwalten" (bzw. Admin); mandantId immer aus dem Login.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import {
  EinkaufBestellstatusSchema,
  EinkaufBestellungEmailSchema,
  EinkaufBestellungInputSchema,
  EinkaufBestellungUpdateSchema,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { lieferanten, mandanten } from '../db/schema.js'
import {
  EinkaufError,
  aktualisiereBestellung,
  erstelleBestellung,
  holeBestellung,
  listeBestellungen,
  loescheEntwurf,
  wechsleStatus,
} from '../services/einkauf-bestellung.service.js'
import { erzeugeBestellungPdf, formatDatum } from '../services/einkauf-bestellung-pdf.service.js'
import { EmailVersandError, isEmailAktiv, sendeBestellungEmail } from '../services/email.service.js'

export interface EinkaufBestellungRouteOptions { db: Db; config: Config }

const IdParam = z.object({ id: z.string().guid() })
const ListeQuery = z.object({
  status:      EinkaufBestellstatusSchema.optional(),
  lieferantId: z.string().guid().optional(),
})
const StatusBody = z.object({ status: EinkaufBestellstatusSchema, gesendetAn: z.string().trim().max(200).optional() })

export const einkaufBestellungRoute: FastifyPluginAsync<EinkaufBestellungRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const darfVerwalten = (request: FastifyRequest): boolean =>
    request.user.rolle === 'admin' || request.user.berechtigungen.includes('artikel.verwalten')

  /** Fachfehler (404/409 …) mit Meldung, alles andere weiter nach oben */
  const fehlerAntwort = (err: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof EinkaufError) return reply.status(err.httpStatus).send({ fehler: err.message })
    throw err
  }

  async function pdfFuer(id: string, mandantId: string) {
    const bestellung = await holeBestellung(db, id, mandantId)
    if (!bestellung) throw new EinkaufError(404, 'Bestellung nicht gefunden')
    const [m] = await db.select({
      firmenname: mandanten.firmenname, uid: mandanten.uid, kopf: mandanten.belegKopftext, fuss: mandanten.belegFusstext,
    }).from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
    const [l] = await db.select().from(lieferanten).where(eq(lieferanten.id, bestellung.lieferantId)).limit(1)
    if (!m || !l) throw new EinkaufError(404, 'Bestellung nicht gefunden')
    const pdf = await erzeugeBestellungPdf(
      bestellung,
      { firmenname: m.firmenname, uid: m.uid, kopftext: m.kopf, fusstext: m.fuss },
      {
        name: l.name, kontakt: l.kontakt, strasse: l.strasse, plz: l.plz, ort: l.ort, land: l.land, uid: l.uid,
        kundennummer: l.kundennummer, zahlungsbedingung: l.zahlungsbedingung,
      },
    )
    return { bestellung, pdf, firmenname: m.firmenname, lieferantEmail: l.email }
  }

  fastify.get('/einkauf/bestellungen', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const q = ListeQuery.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })
    return reply.send(await listeBestellungen(db, request.user.mandantId, q.data))
  })

  fastify.post('/einkauf/bestellungen', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const b = EinkaufBestellungInputSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.status(201).send(await erstelleBestellung(db, request.user.mandantId, b.data))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/einkauf/bestellungen/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = await holeBestellung(db, p.data.id, request.user.mandantId)
    if (!b) return reply.status(404).send({ fehler: 'Bestellung nicht gefunden' })
    return reply.send(b)
  })

  fastify.put('/einkauf/bestellungen/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = EinkaufBestellungUpdateSchema.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    try {
      return reply.send(await aktualisiereBestellung(db, p.data.id, request.user.mandantId, b.data))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.delete('/einkauf/bestellungen/:id', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      await loescheEntwurf(db, p.data.id, request.user.mandantId)
      return reply.status(204).send()
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.post('/einkauf/bestellungen/:id/status', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = StatusBody.safeParse(request.body)
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    if (b.data.status === 'teilgeliefert') {
      return reply.status(409).send({ fehler: '„Teilweise geliefert" setzt der Wareneingang, nicht ein manueller Statuswechsel' })
    }
    try {
      return reply.send(await wechsleStatus(db, p.data.id, request.user.mandantId, b.data.status, b.data.gesendetAn))
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.get('/einkauf/bestellungen/:id/pdf', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    try {
      const { bestellung, pdf } = await pdfFuer(p.data.id, request.user.mandantId)
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="Bestellung-${bestellung.nummer}.pdf"`)
        .send(pdf)
    } catch (err) { return fehlerAntwort(err, reply) }
  })

  fastify.post('/einkauf/bestellungen/:id/email', auth, async (request, reply) => {
    if (!darfVerwalten(request)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const p = IdParam.safeParse(request.params)
    if (!p.success) return reply.status(400).send({ fehler: 'Ungültige ID' })
    const b = EinkaufBestellungEmailSchema.safeParse(request.body ?? {})
    if (!b.success) return reply.status(400).send({ fehler: b.error.issues })
    if (!isEmailAktiv(opts.config)) {
      return reply.status(409).send({ fehler: 'E-Mail-Versand ist nicht konfiguriert (SMTP-Einstellungen fehlen)' })
    }
    try {
      const { bestellung, pdf, firmenname, lieferantEmail } = await pdfFuer(p.data.id, request.user.mandantId)
      if (bestellung.status !== 'entwurf' && bestellung.status !== 'gesendet') {
        return reply.status(409).send({ fehler: 'Diese Bestellung kann nicht mehr versendet werden' })
      }
      const empfaenger = b.data.empfaenger ?? lieferantEmail
      if (!empfaenger) {
        return reply.status(409).send({ fehler: 'Beim Lieferanten ist keine E-Mail-Adresse hinterlegt — bitte eine Adresse angeben' })
      }
      await sendeBestellungEmail(empfaenger, {
        firmenname,
        nummer:       bestellung.nummer,
        lieferant:    bestellung.lieferantName,
        liefertermin: bestellung.liefertermin ? formatDatum(bestellung.liefertermin) : null,
        bemerkung:    bestellung.bemerkung,
      }, pdf, opts.config)
      // Erst NACH erfolgreichem Versand als gesendet markieren
      return reply.send(await wechsleStatus(db, p.data.id, request.user.mandantId, 'gesendet', empfaenger))
    } catch (err) {
      if (err instanceof EmailVersandError) return reply.status(err.httpStatus).send({ fehler: `E-Mail fehlgeschlagen: ${err.message}` })
      return fehlerAntwort(err, reply)
    }
  })
}
