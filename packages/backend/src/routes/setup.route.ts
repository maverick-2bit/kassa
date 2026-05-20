/**
 * POST /api/setup – Einmalige Kasseneinrichtung
 *
 * Erwartet ein JSON-Body gemäß SetupInputSchema und ruft den Setup-Service auf.
 * Antwortet mit SetupResponse (auch im Fehlerfall, dann HTTP 400).
 *
 * Diese Route ist absichtlich NICHT auth-geschützt — sie ist der erste Aufruf
 * den eine frisch installierte Kasse macht. Nach erfolgreichem Setup wird eine
 * separate Login-Route benötigt (kommt später).
 */

import type { FastifyPluginAsync } from 'fastify'
import { SetupInputSchema, type SetupResponse } from '@kassa/shared'
import { fuehreSetupDurch, type SetupServiceDeps } from '../services/setup.service.js'

export interface SetupRoutePluginOptions {
  deps: SetupServiceDeps
}

export const setupRoute: FastifyPluginAsync<SetupRoutePluginOptions> = async (fastify, opts) => {
  fastify.post('/setup', async (request, reply) => {
    // Eingabe-Validierung via Zod (zusätzlich zu der innerhalb von kasseAutomatischEinrichten)
    const parsed = SetupInputSchema.safeParse(request.body)
    if (!parsed.success) {
      const meldung = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      const response: SetupResponse = {
        erfolgreich: false,
        schritte: [{
          schritt:     'eingabe-validierung',
          status:      'fehler',
          meldung,
          zeitstempel: new Date().toISOString(),
        }],
        fehler: meldung,
      }
      return reply.status(400).send(response)
    }

    try {
      const result = await fuehreSetupDurch(parsed.data, opts.deps)
      if (!result.erfolgreich) {
        return reply.status(400).send(result)
      }
      return reply.status(201).send(result)
    } catch (err) {
      fastify.log.error({ err }, 'Setup unerwartet fehlgeschlagen')
      const meldung = err instanceof Error ? err.message : String(err)
      const response: SetupResponse = {
        erfolgreich: false,
        schritte: [{
          schritt:     'eingabe-validierung',
          status:      'fehler',
          meldung,
          zeitstempel: new Date().toISOString(),
        }],
        fehler: meldung,
      }
      return reply.status(500).send(response)
    }
  })
}
