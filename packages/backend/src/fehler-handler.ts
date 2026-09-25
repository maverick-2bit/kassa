/**
 * Globaler Fehler-Handler: antwortet auf alles, was eine Route nicht selbst
 * beantwortet — geworfene oder weitergereichte Fehler, Hook-Fehler, Fastify-Fehler.
 *
 * Unerwartete Fehler gehen NIE im Wortlaut an den Client: Eine DB-Fehlermeldung
 * lautet (drizzle-orm) „Failed query: <SQL> params: <Werte>" — mit Tabellen-,
 * Spalten- und Constraint-Namen und den Eingabewerten. Der Client bekommt nur
 * { fehler: 'Interner Serverfehler' }, die Einzelheiten stehen im Log.
 *
 * Fehler mit einem Status unter 500 sind dagegen Antworten an den Client und
 * behalten Status und Antwort:
 *  - Fastify-Fehler mit statusCode (Schema-Validierung 400, kaputtes JSON 400,
 *    Body zu groß 413, Rate-Limit 429 …) genau so, wie Fastify sie ohne eigenen
 *    Handler liefert
 *  - Fachfehler der Services (BelegError, KundeError … mit httpStatus), die eine
 *    Route nicht selbst abfängt, so, wie die Routen sie beantworten: { fehler }
 *
 * Registrierung: in buildServer VOR allen Plugins und Routen — Fastify gibt den
 * Handler nur an Plugin-Kontexte weiter, die nach dem Aufruf entstehen.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'

const INTERN = { fehler: 'Interner Serverfehler' } as const

function istFehlerStatus(wert: unknown): wert is number {
  return typeof wert === 'number' && Number.isInteger(wert) && wert >= 400 && wert <= 599
}

/**
 * statusCode — Fastify-Konvention (Validierung, Content-Type-Parser, Plugins, das
 * Antwortobjekt des Rate-Limits). Bewusst NICHT das Feld `status`: Darin tragen
 * FonSoapError und ATrustHsmError den HTTP-Status der Gegenstelle (FinanzOnline,
 * A-Trust) — deren 401 ist kein 401 der Kasse, bei dem die Oberfläche abmeldet.
 */
function fastifyStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { statusCode } = error as { statusCode?: unknown }
  return istFehlerStatus(statusCode) ? statusCode : undefined
}

/** httpStatus — Fachfehler-Konvention der Services: Error mit Meldung für die Oberfläche. */
export function fachfehlerStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  const { httpStatus } = error as { httpStatus?: unknown }
  return istFehlerStatus(httpStatus) ? httpStatus : undefined
}

export function fehlerHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const statusFastify = fastifyStatus(error)
  const status        = statusFastify ?? fachfehlerStatus(error)
  // SSE-Routen schreiben raw.writeHead selbst — danach geht keine Antwort mehr
  const streamLaeuft  = reply.raw.headersSent

  if (status !== undefined && status < 500 && !streamLaeuft) {
    if (statusFastify === undefined) {
      // Fachfehler, den die Route nicht selbst abfängt (z. B. BelegError beim Tisch-Bezahlen)
      const { message, code } = error as Error & { code?: unknown }
      return reply.code(status).send({ fehler: message, ...(typeof code === 'string' && { code }) })
    }
    // An den Fastify-Standard-Handler weiterreichen (reply.send mit einem Error im
    // Fehler-Handler = Eltern-Handler): gleicher Status, gleiche Antwort
    // { statusCode, code, error, message }, gleiches Logging wie bisher.
    if (error instanceof Error) return reply.send(error)
    // Geworfenes Antwortobjekt — der errorResponseBuilder des Rate-Limits wirft
    // { statusCode: 429, fehler } — unverändert mit seinem Status senden.
    return reply.code(status).send(error)
  }

  request.log.error({ err: error, url: request.url, method: request.method }, 'Unbehandelter Serverfehler')
  if (reply.sent) return undefined
  if (streamLaeuft) {
    // Fehler nach raw.writeHead (z. B. Snapshot-Abfrage einer SSE-Route): Stream
    // beenden. Sonst hinge die Verbindung ohne Daten, und Fastifys Antwortversuch
    // endete als unbehandelte Rejection (ERR_HTTP_HEADERS_SENT). Nach dem Ende
    // verbindet sich der EventSource-Client von selbst neu.
    reply.hijack()
    reply.raw.end()
    return undefined
  }
  return reply.code(status ?? 500).send(INTERN)
}
