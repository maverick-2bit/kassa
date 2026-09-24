/**
 * Einordnung im globalen Fehler-Handler — ohne DB, mit Fehlern, die sich über
 * echte Routen nicht gezielt auslösen lassen. Das Zusammenspiel mit den echten
 * Routen prüft tests/integration/fehler-handler.test.ts.
 */

import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'
import { ATrustHsmError, FonSoapError } from '@kassa/rksv'
import { fehlerHandler } from '../src/fehler-handler.js'
import { BelegError } from '../src/services/beleg.service.js'
import { FreigabeError } from '../src/services/freigabe.service.js'

const INTERN = { fehler: 'Interner Serverfehler' }

/** Minimal-Server mit dem Handler und einer Route, die `fehler` wirft. */
async function antwortAuf(fehler: unknown) {
  const app = Fastify()
  app.setErrorHandler(fehlerHandler)
  app.get('/', async () => { throw fehler })
  const res = await app.inject({ method: 'GET', url: '/' })
  await app.close()
  return { status: res.statusCode, body: res.json() as unknown }
}

describe('Fehler-Handler: Einordnung', () => {
  it.each([
    ['Fachfehler 4xx → Status + Meldung wie in den Routen',
      new BelegError(409, 'Kasse ist außer Betrieb'), 409, { fehler: 'Kasse ist außer Betrieb' }],
    ['Fachfehler mit Code → Code bleibt (PIN-Dialog der Freigabe)',
      new FreigabeError('Rabatt ab 10,00 € muss freigegeben werden.', 1000), 403,
      { fehler: 'Rabatt ab 10,00 € muss freigegeben werden.', code: 'freigabe_erforderlich' }],
    ['Fachfehler 5xx → generisch, Status bleibt',
      new BelegError(502, 'FinanzOnline-Registrierung fehlgeschlagen'), 502, INTERN],
    ['A-Trust-401 (Status der Gegenstelle in `status`) → kein 401 für die Kasse',
      new ATrustHsmError('A-Trust antwortet 401 Unauthorized', 401), 500, INTERN],
    ['FinanzOnline-Fehler mit `status` → 500',
      new FonSoapError('SOAP-Fault: Session abgelaufen', 403), 500, INTERN],
    ['Fastify-Fehler mit statusCode 5xx → generisch, Status bleibt',
      Object.assign(new Error('Handler-Timeout intern'), { statusCode: 503 }), 503, INTERN],
    ['statusCode außerhalb 400–599 → 500',
      Object.assign(new Error('seltsam'), { statusCode: 302 }), 500, INTERN],
    ['kein Error-Objekt → 500',
      'nur ein String', 500, INTERN],
  ])('%s', async (_fall, fehler, status, body) => {
    const res = await antwortAuf(fehler)
    expect(res.status).toBe(status)
    expect(res.body).toEqual(body)
  })

  it('Fastify-Fehler 4xx gehen unverändert an den Fastify-Standard-Handler', async () => {
    const res = await antwortAuf(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }))
    expect(res.status).toBe(415)
    expect(res.body).toEqual({
      statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', error: 'Unsupported Media Type', message: 'Unsupported Media Type',
    })
  })

  it('geworfenes Antwortobjekt (Rate-Limit) geht unverändert mit seinem Status raus', async () => {
    const res = await antwortAuf({ statusCode: 429, fehler: 'Zu viele Anfragen. Bitte in 60 Sekunden erneut versuchen.' })
    expect(res.status).toBe(429)
    expect(res.body).toEqual({ statusCode: 429, fehler: 'Zu viele Anfragen. Bitte in 60 Sekunden erneut versuchen.' })
  })
})
