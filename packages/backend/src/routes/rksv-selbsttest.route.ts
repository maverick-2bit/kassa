/**
 * RKSV-Signatur-Selbsttest (Guard: nur Admin).
 *
 *   GET /api/rksv/signatur-selbsttest?kasseId=…       Prüfergebnis als JSON
 *   GET /api/rksv/signatur-selbsttest.csv?kasseId=…   Auffällige Belege als CSV
 *
 * Verifiziert alle Belege der Kasse gegen das SEE-Zertifikat (reine Lese-
 * Operation, nur öffentliches Schlüsselmaterial) — inklusive Erkennung der vor
 * dem P1363-Fix DER-codiert signierten Alt-Belege.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { fuehreSignaturSelbsttestAus } from '../services/rksv-selbsttest.service.js'

export interface RksvSelbsttestRouteOptions { db: Db }

const Query = z.object({ kasseId: z.string().uuid() })

const STATUS_LABEL: Record<string, string> = {
  ausfall:       'SEE-Ausfall (erwartet unsigniert)',
  der_altformat: 'Altformat DER (kryptographisch korrekt)',
  ungueltig:     'UNGÜLTIG',
}

export const rksvSelbsttestRoute: FastifyPluginAsync<RksvSelbsttestRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }
  const { db } = opts

  const istAdmin = (request: FastifyRequest): boolean => request.user.rolle === 'admin'

  fastify.get('/rksv/signatur-selbsttest', auth, async (request, reply) => {
    if (!istAdmin(request)) return reply.status(403).send({ fehler: 'Nur für Administratoren' })
    const q = Query.safeParse(request.query ?? {})
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    const res = await fuehreSignaturSelbsttestAus(db, request.user.mandantId, q.data.kasseId)
    if (!res) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    return reply.send(res.ergebnis)
  })

  fastify.get('/rksv/signatur-selbsttest.csv', auth, async (request, reply) => {
    if (!istAdmin(request)) return reply.status(403).send({ fehler: 'Nur für Administratoren' })
    const q = Query.safeParse(request.query ?? {})
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    const res = await fuehreSignaturSelbsttestAus(db, request.user.mandantId, q.data.kasseId)
    if (!res) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const { ergebnis, alleDetails } = res
    const zeilen: string[] = [
      'Belegnummer;Datum;Belegtyp;Status',
      ...alleDetails.map(d =>
        `${d.belegNummer};${d.belegDatum};${d.belegTyp};${STATUS_LABEL[d.status] ?? d.status}`),
    ]

    const datum     = new Date().toISOString().slice(0, 10)
    const dateiname = `signatur-selbsttest_${ergebnis.kassenId}_${datum}.csv`
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${dateiname}"`)
      .send(String.fromCharCode(0xFEFF) + zeilen.join('\r\n'))  // BOM für Excel-UTF-8-Erkennung
  })
}
