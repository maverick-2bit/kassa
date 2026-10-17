/**
 * Mandanten-Übergabe in der Kassa (statt PowerShell): den eigenen Mandanten als verschlüsselte
 * Datei (.kuep) herunterladen bzw. eine solche Datei als ZUSÄTZLICHEN Mandanten einspielen.
 *
 *  POST /mandant-uebergabe/export  (admin) { passwort }          → Datei (application/octet-stream)
 *  POST /mandant-uebergabe/import  (admin) { passwort, datei }   → Bericht; datei = Base64 der .kuep
 *
 * Exportiert wird immer der Mandant des angemeldeten Admins (JWT), nie einer aus dem Body.
 * Der Import legt nur einen NEUEN Mandanten an und rührt vorhandene Daten nicht an.
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import postgres from 'postgres'
import {
  exportiereMandant, importiereMandant, type MandantExport,
} from '../services/mandant-transfer.service.js'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { mandanten } from '../db/schema.js'
import { MANDANT_UEBERTRAGEN } from '../services/beleg.service.js'
import {
  entschluesselePaket, verschluesselePaket, MIN_PASSWORT_LAENGE, UebergabeDateiError,
} from '../crypto/uebergabe-datei.js'

export interface MandantTransferRouteOptions {
  db:               Db
  databaseUrl:      string
  masterPassphrase: string
}

const ExportSchema = z.object({ passwort: z.string().min(MIN_PASSWORT_LAENGE), sperren: z.boolean().default(true) })
const ImportSchema = z.object({ passwort: z.string().min(1), datei: z.string().min(1) })

/** Dateiname-tauglicher Kurzname */
function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mandant'
}

export const mandantTransferRoute: FastifyPluginAsync<MandantTransferRouteOptions> = async (fastify, opts) => {
  function nurAdmin(request: Parameters<typeof fastify.authenticate>[0], reply: Parameters<typeof fastify.authenticate>[1], done: () => void) {
    if (request.user.rolle !== 'admin') {
      reply.status(403).send({ fehler: 'Nur Admins können Mandanten übertragen' })
      return
    }
    done()
  }
  const adminGuard = { onRequest: [fastify.authenticate, nurAdmin] }

  /** Eigene kurze Verbindung (der Pool der App wird nicht belegt) */
  async function mitVerbindung<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} })
    try { return await fn(sql) } finally { await sql.end() }
  }

  fastify.post('/mandant-uebergabe/export', adminGuard, async (request, reply) => {
    const parsed = ExportSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: `Das Übergabe-Passwort braucht mindestens ${MIN_PASSWORT_LAENGE} Zeichen.` })

    const daten = await mitVerbindung(sql => exportiereMandant(sql, request.user.mandantId, opts.masterPassphrase))
    const paket = verschluesselePaket(Buffer.from(JSON.stringify(daten), 'utf8'), parsed.data.passwort)
    const datum = new Date().toISOString().slice(0, 10)
    // Erst NACH erfolgreicher Verschlüsselung sperren; rückgängig: POST …/sperre-aufheben
    if (parsed.data.sperren) {
      await opts.db.update(mandanten).set({ status: MANDANT_UEBERTRAGEN }).where(eq(mandanten.id, request.user.mandantId))
      fastify.log.warn({ mandantId: request.user.mandantId }, 'Mandant für Belege gesperrt (Übergabe-Export)')
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="kassa-mandant-${slug(daten.name)}-${datum}.kuep"`)
      .header('Cache-Control', 'no-store')
      .send(paket)
  })

  fastify.get('/mandant-uebergabe/status', adminGuard, async (request) => {
    const [m] = await opts.db.select({ status: mandanten.status }).from(mandanten).where(eq(mandanten.id, request.user.mandantId))
    return { gesperrt: m?.status === MANDANT_UEBERTRAGEN }
  })

  fastify.post('/mandant-uebergabe/sperre-aufheben', adminGuard, async (request) => {
    await opts.db.update(mandanten).set({ status: 'aktiv' }).where(eq(mandanten.id, request.user.mandantId))
    fastify.log.warn({ mandantId: request.user.mandantId }, 'Übergabe-Sperre aufgehoben')
    return { gesperrt: false }
  })

  fastify.post('/mandant-uebergabe/import', { ...adminGuard, bodyLimit: 200 * 1024 * 1024 }, async (request, reply) => {
    const parsed = ImportSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: 'Passwort und Datei sind nötig.' })

    try {
      const klar  = entschluesselePaket(Buffer.from(parsed.data.datei, 'base64'), parsed.data.passwort)
      const daten = JSON.parse(klar.toString('utf8')) as MandantExport
      const bericht = await mitVerbindung(sql => importiereMandant(sql, daten, opts.masterPassphrase))
      fastify.log.info({ mandantId: bericht.mandantId, von: request.user.mandantId }, 'Mandant übertragen (Import)')
      return reply.status(201).send({
        name:     bericht.name,
        tabellen: Object.keys(bericht.zeilen).length,
        zeilen:   Object.values(bericht.zeilen).reduce((n, z) => n + z, 0),
      })
    } catch (err) {
      if (err instanceof UebergabeDateiError) return reply.status(400).send({ fehler: err.message })
      if (err instanceof postgres.PostgresError && err.code === '23505') {
        fastify.log.warn({ err }, 'Mandanten-Import: Konflikt mit vorhandenen Daten')
        return reply.status(409).send({ fehler: 'Konflikt mit vorhandenen Daten (z. B. dieselbe E-Mail eines Benutzers oder dieselbe Kassen-ID gibt es hier schon). Es wurde nichts geändert.' })
      }
      // Fachliche Meldungen des Services (Version zu alt, Mandant schon vorhanden, ungültige Datei …)
      if (err instanceof Error && !(err instanceof postgres.PostgresError) && !(err instanceof SyntaxError)) {
        return reply.status(400).send({ fehler: err.message })
      }
      if (err instanceof SyntaxError) return reply.status(400).send({ fehler: 'Die Datei enthält keine gültigen Daten.' })
      throw err
    }
  })
}
