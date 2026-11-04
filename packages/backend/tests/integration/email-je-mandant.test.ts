/**
 * Integrationstest: dieselbe E-Mail-Adresse in mehreren Betrieben (Mandanten).
 *
 * Früher war die E-Mail über die ganze Installation eindeutig — wer mehrere Betriebe führt, brauchte je Betrieb eine
 * andere Adresse. Jetzt gilt die Eindeutigkeit je Mandant:
 *   - die Einrichtung eines weiteren Mandanten mit derselben Admin-E-Mail klappt
 *   - die Anmeldung erkennt den Betrieb am Passwort
 *   - passt das Passwort in mehreren Betrieben, antwortet der Server mit der Auswahl (409) — kein Fehlversuch —
 *     und meldet nach der Wahl (mandantId) an
 *   - innerhalb eines Betriebs bleibt die E-Mail eindeutig
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_SETUP_TOKEN, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const EMAIL = 'inhaber@mehrere-betriebe.at'
const PW_A  = 'betrieb-a-passwort-123'
const PW_B  = 'betrieb-b-passwort-456'

function fo(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'EM-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function einrichtung(nr: number, passwort: string) {
  return {
    firmenname: `Betrieb ${nr} GmbH`,
    uid:        `ATU7777770${nr}`,
    kassenId:   `EM-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-EM-${nr}`, benutzerkennung: `BID-EM-${nr}`, pin: `PIN-EM-${nr}` },
    umgebung: 'test',
    admin: { name: `Inhaber ${nr}`, email: EMAIL, passwort },
  }
}

describe('Dieselbe E-Mail in mehreren Mandanten (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const mandantVon: Record<number, string> = {}

  const setup = (nr: number, passwort: string) => srv.fastify.inject({
    method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: einrichtung(nr, passwort),
  })
  const login = (passwort: string, mandantId?: string) => srv.fastify.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: EMAIL, passwort, ...(mandantId ? { mandantId } : {}) },
  })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    // IP-Rate-Limit hochgestellt: geprüft wird die Sperre je E-Mail (Fehlversuche), nicht das Anfragen-Limit
    srv = await buildTestServer(idb.db, { finanzOnlineClient: fo(), config: { LOGIN_RATE_LIMIT_MAX: 1000 } })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('ein zweiter Mandant lässt sich mit derselben Admin-E-Mail einrichten', async () => {
    const erster = await setup(1, PW_A)
    expect(erster.statusCode, erster.body).toBe(201)
    const zweiter = await setup(2, PW_B)
    expect(zweiter.statusCode, zweiter.body).toBe(201)
  })

  it('die Anmeldung erkennt den Betrieb am Passwort', async () => {
    const a = await login(PW_A)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json().mandant.firmenname).toBe('Betrieb 1 GmbH')
    mandantVon[1] = a.json().mandant.id

    const b = await login(PW_B)
    expect(b.statusCode, b.body).toBe(200)
    expect(b.json().mandant.firmenname).toBe('Betrieb 2 GmbH')
    mandantVon[2] = b.json().mandant.id
    expect(mandantVon[2]).not.toBe(mandantVon[1])

    const falsch = await login('ganz-falsches-passwort')
    expect(falsch.statusCode).toBe(401)
  })

  it('mit der Betriebs-Angabe wird nur dort angemeldet', async () => {
    const richtig = await login(PW_B, mandantVon[2])
    expect(richtig.statusCode).toBe(200)
    expect(richtig.json().mandant.id).toBe(mandantVon[2])

    // Passwort von Betrieb A im Betrieb B → falsch
    const verkehrt = await login(PW_A, mandantVon[2])
    expect(verkehrt.statusCode).toBe(401)
  })

  it('passt das Passwort in mehreren Betrieben, kommt die Auswahl — und nach der Wahl die Anmeldung', async () => {
    // dritter Betrieb mit demselben Passwort wie Betrieb A
    const dritter = await setup(3, PW_A)
    expect(dritter.statusCode, dritter.body).toBe(201)

    const auswahl = await login(PW_A)
    expect(auswahl.statusCode).toBe(409)
    const body = auswahl.json() as { fehler: string; mandantAuswahl: Array<{ id: string; firmenname: string }> }
    expect(body.mandantAuswahl.map(b => b.firmenname)).toEqual(['Betrieb 1 GmbH', 'Betrieb 3 GmbH'])
    expect(JSON.stringify(body)).not.toContain('Betrieb 2')   // nur Betriebe, in denen das Passwort passt

    const gewaehlt = body.mandantAuswahl.find(b => b.firmenname === 'Betrieb 3 GmbH')!
    const ok = await login(PW_A, gewaehlt.id)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().mandant.firmenname).toBe('Betrieb 3 GmbH')

    // Betrieb B ist davon unberührt
    expect((await login(PW_B)).json().mandant.firmenname).toBe('Betrieb 2 GmbH')
  })

  it('die Betriebs-Auswahl zählt nicht als Fehlversuch (keine Sperre nach vielen Auswahlen)', async () => {
    for (let i = 0; i < 15; i++) expect((await login(PW_A)).statusCode).toBe(409)
    expect((await login(PW_B)).statusCode).toBe(200)
  })

  it('innerhalb eines Betriebs bleibt die E-Mail eindeutig; in einem anderen Betrieb darf sie wiederkehren', async () => {
    const token = (await login(PW_B)).json().token as string
    const auth = { authorization: `Bearer ${token}` }

    // Ein weiterer Benutzer in Betrieb 2 mit der Adresse des Admins → 409
    const doppelt = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth,
      payload: { name: 'Doppelt', email: EMAIL, passwort: 'doppelt-passwort-1', rolle: 'admin', berechtigungen: [], kassenIds: [] },
    })
    expect(doppelt.statusCode, doppelt.body).toBe(409)
    expect(doppelt.json()).toEqual({ fehler: 'E-Mail bereits vergeben' })

    // Dieselbe Adresse, die in Betrieb 1/3 schon vorkommt, ist für einen Mitarbeiter in Betrieb 2 frei, wenn sie dort neu ist
    const neu = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: auth,
      payload: { name: 'Kollege', email: 'kollege@mehrere-betriebe.at', passwort: 'kollege-passwort-1', rolle: 'admin', berechtigungen: [], kassenIds: [] },
    })
    expect(neu.statusCode, neu.body).toBe(201)
  })
})
