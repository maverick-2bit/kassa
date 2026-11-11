/**
 * Betreiber der Installation.
 *
 * Eine Kassa-Installation hostet mehrere Mandanten, jeder mit eigenen Admins. Manches betrifft
 * aber nicht einen Mandanten, sondern den ganzen Rechner: ein Dump der GANZEN Datenbank, das
 * Update der Software, Systemwerte, ein weiterer Mandant. Das darf nicht jeder Mandanten-Admin —
 * sonst zieht der Admin eines kleinen Betriebs die Daten aller anderen herunter.
 *
 * Betreiber ist, wer in `users.ist_betreiber` steht (Migration 0072, Ersteinrichtung, SQL).
 * Geprüft wird IMMER gegen die Datenbank und nie gegen das Token: Ein Token gilt Stunden und
 * lässt sich nicht widerrufen — ein deaktiviertes oder entmachtetes Konto bliebe sonst bis zum
 * Ablauf Betreiber.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { users } from '../db/schema.js'
import { alsWaechter } from './waechter.js'

export const BETREIBER_FEHLER = 'Das darf nur der Betreiber dieser Kassa.'

/** Ist dieses Konto jetzt gerade ein aktiver Admin mit Betreiber-Markierung? */
export async function istAktiverBetreiber(db: Db, userId: string, mandantId: string): Promise<boolean> {
  const [zeile] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.id, userId),
      eq(users.mandantId, mandantId),
      eq(users.rolle, 'admin'),
      eq(users.aktiv, true),
      eq(users.istBetreiber, true),
    ))
    .limit(1)
  return zeile !== undefined
}

/** onRequest-Hook NACH `fastify.authenticate` (setzt `request.user`): lässt nur den Betreiber durch. */
export function requireBetreiber(db: Db) {
  return alsWaechter(async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await istAktiverBetreiber(db, request.user.sub, request.user.mandantId))) {
      return reply.status(403).send({ fehler: BETREIBER_FEHLER })
    }
  }, { art: 'betreiber' })
}
