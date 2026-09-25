import type { FastifyPluginAsync } from 'fastify'
import { BonierungInputSchema, bonierFehlschlaege } from '@kassa/shared'
import {
  bonierBestellung,
  BonierError,
  type BonierServiceDeps,
} from '../services/bonier.service.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface BonierRouteOptions {
  deps: BonierServiceDeps
}

export const bonierRoute: FastifyPluginAsync<BonierRouteOptions> = async (fastify, opts) => {
  fastify.post('/bestellung/bonieren', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = BonierungInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    // Mandant-Scope-Check
    if (!(await pruefeKasseGehoertZuMandant(opts.deps.db, parsed.data.kasseId, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })
    }

    try {
      // Die Flags kommen im Body, wirken aber nur als Optionen — im Input lässt
      // bonierBestellung sie nicht zu (BonierBestellung).
      const { ohneLagerabzug, storno, ...bestellung } = parsed.data
      const ergebnis = await bonierBestellung(bestellung, opts.deps, {
        ...(ohneLagerabzug && { ohneLagerabzug: true }),
        ...(storno && { storno: true }),
      })
      // 207 sobald IRGENDEIN Ziel den Bon nicht bekommen hat — Stationen wie
      // Bonierdrucker. Bis v0.7.142 wurden nur die Stationen geprüft, ein toter
      // Küchendrucker meldete also 200 (siehe bonierFehlschlaege).
      const fehlend = bonierFehlschlaege(ergebnis)
      return reply.status(fehlend.length === 0 ? 200 : 207).send(ergebnis)
    } catch (err) {
      if (err instanceof BonierError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      throw err
    }
  })
}
