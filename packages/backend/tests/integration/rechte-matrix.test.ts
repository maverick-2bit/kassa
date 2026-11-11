/**
 * Integrationstest: Rechte-Matrix (Prüfbericht 2026-11, Befund 3).
 *
 * tests/route-schutz.test.ts beweist ohne Datenbank, dass jede Route einen Wächter hat und der Wächter Unbefugte
 * abweist. Dieser Test beweist die Gegenseite mit echtem PostgreSQL: WER durch den Wächter kommt, wird auch vom Handler
 * nicht abgewiesen. Er ruft jede Route der Rechte-Tabelle einmal je erlaubtem Recht auf (Kellner mit genau diesem Recht,
 * leerer Body, Platzhalter-ID) und verlangt: weder 401 noch 403. So fällt auf, wenn die Tabelle großzügiger ist als eine
 * Prüfung im Handler (z. B. „nur Admin") — dann würde die Seite für Berechtigte mit „Keine Berechtigung" scheitern.
 *
 * Außerdem: Der Kellner-Alltag (Tische, Bonieren, Bezahlen, Karte lesen) bleibt ohne jedes Recht benutzbar — die
 * Kellner-App prüft selbst keine Rechte, ein Aussperren bestehender Konten wäre ein Betriebsausfall.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Berechtigung } from '@kassa/shared'
import type { RoutenEintrag } from '../../src/server.js'
import { waechterVon, type Waechter } from '../../src/auth/waechter.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const UUID = '00000000-0000-4000-8000-0000000000aa'

/**
 * Routen, deren Handler auch für Berechtigte legitim 403 liefern kann — mit Grund. Hier steht NICHTS, was an einem Recht
 * hängt: ein 403 wegen fehlenden Rechts wäre genau der Fehler, den dieser Test finden soll.
 */
const AUSNAHMEN: Readonly<Record<string, string>> = {
  'GET /api/sprache/synonyme':             'Modul „Sprachbestellung" ist im frischen Test-Betrieb aus: 403 mit Modul-Hinweis, unabhängig vom Recht',
  'GET /api/sprache/artikel/:id/synonyme': 'wie oben: Modul „Sprachbestellung" aus',
}

interface Route { schluessel: string; methode: string; url: string; waechter: Waechter[] }

describe('Rechte-Matrix (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let routen: Route[] = []

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    const register: RoutenEintrag[] = []
    srv = await buildTestServer(idb.db, { routenRegister: register, config: { DATABASE_URL: idb.url } })
    routen = register.flatMap(r =>
      (Array.isArray(r.method) ? r.method : [r.method])
        .filter(m => m !== 'HEAD' && m !== 'OPTIONS')
        .map(m => ({ schluessel: `${m} ${r.url}`, methode: m, url: r.url, waechter: waechterVon(r.onRequest) })),
    )
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  const konkret = (url: string) => url.replace(/:[A-Za-z0-9_]+/g, UUID)

  const rufe = (r: Route, kopf: { authorization: string }) => srv.fastify.inject({
    method:  r.methode as 'GET',
    url:     konkret(r.url),
    headers: kopf,
    ...(['POST', 'PUT', 'PATCH'].includes(r.methode) ? { payload: {} } : {}),
  })

  /** Wer darf die Route? Eine Identität je erlaubtem Recht (Kellner mit genau diesem Recht), Admin bei Rollen-Wächtern. */
  const erlaubte = (r: Route): Array<{ name: string; kopf: { authorization: string } }> | null => {
    if (r.waechter.some(w => w.art === 'betreiber' || w.art === 'geraet')) return null // eigene Tests (betreiber.test.ts, Einlass)
    if (r.waechter.length === 0) return null                                          // öffentlich

    const recht = r.waechter.find(w => w.art === 'berechtigung')
    if (recht?.art === 'berechtigung') {
      return recht.berechtigungen.map(b => ({
        name: `Kellner mit „${b}"`,
        kopf: srv.authHeader({ rolle: 'kellner', berechtigungen: [b as Berechtigung] }),
      }))
    }
    if (r.waechter.some(w => w.art === 'rolle')) {
      return [{ name: 'Admin', kopf: srv.authHeader({ rolle: 'admin', berechtigungen: [] }) }]
    }
    return [{ name: 'Kellner ohne Rechte', kopf: srv.authHeader({ rolle: 'kellner', berechtigungen: [] }) }]
  }

  it('wer durch den Wächter kommt, wird vom Handler nicht mit 401/403 abgewiesen (jede Route, jedes erlaubte Recht)', async () => {
    const probleme: string[] = []
    let geprueft = 0

    for (const r of routen) {
      const identitaeten = erlaubte(r)
      if (!identitaeten) continue
      for (const wer of identitaeten) {
        const res = await rufe(r, wer.kopf)
        geprueft++
        if ((res.statusCode === 401 || res.statusCode === 403) && !AUSNAHMEN[r.schluessel]) {
          probleme.push(`${r.schluessel} als ${wer.name}: ${res.statusCode} ${res.body.slice(0, 120)}`)
        }
      }
    }

    expect(geprueft).toBeGreaterThan(300)
    expect(probleme, probleme.join('\n')).toEqual([])
  }, 180_000)

  it('Kellner-Alltag: Tische, Bonieren, Bezahlen, Karte lesen gehen auch ohne jedes Recht (die Kellner-App prüft keine Rechte)', async () => {
    const kellner = srv.authHeader({ rolle: 'kellner', berechtigungen: [] })
    const alltag: Array<[string, string]> = [
      ['GET',  '/api/artikel'],
      ['GET',  '/api/kategorien'],
      ['GET',  '/api/tischplan/bereiche'],
      ['GET',  '/api/tisch-tabs'],
      ['POST', '/api/tisch-tabs'],
      ['PUT',  `/api/tisch-tabs/${UUID}/positionen`],
      ['POST', `/api/tisch-tabs/${UUID}/bezahlen`],
      ['POST', '/api/bestellung/bonieren'],
      ['POST', `/api/belege/${UUID}/drucken`],
      ['POST', '/api/zvt/zahlung'],
      ['GET',  `/api/kassen/${UUID}/pos-config`],
      ['GET',  `/api/kassen/${UUID}/favoriten`],
      ['GET',  `/api/kassen/${UUID}/artikel-layouts`],
      ['GET',  `/api/kassen/${UUID}/zvt`],
      ['POST', '/api/kds/antwort'],
    ]
    for (const [methode, url] of alltag) {
      const res = await srv.fastify.inject({
        method: methode as 'GET', url, headers: kellner,
        ...(methode === 'GET' ? {} : { payload: {} }),
      })
      expect(res.statusCode, `${methode} ${url}`).not.toBe(401)
      expect(res.statusCode, `${methode} ${url}`).not.toBe(403)
    }
  })

  it('das Recht wirkt nicht quer: „Tische" öffnet keine Berichte, „Berichte" kein Bezahlen von Gutscheinen', async () => {
    const tische  = srv.authHeader({ rolle: 'kellner', berechtigungen: ['tische'] })
    const berichte = srv.authHeader({ rolle: 'kellner', berechtigungen: ['belege.lesen'] })

    expect((await srv.fastify.inject({ method: 'GET', url: '/api/berichte/umsatz', headers: tische })).statusCode).toBe(403)
    expect((await srv.fastify.inject({ method: 'GET', url: '/api/berichte/umsatz', headers: berichte })).statusCode).not.toBe(403)
    expect((await srv.fastify.inject({ method: 'POST', url: `/api/gutscheine/${UUID}/einloesen`, headers: berichte, payload: {} })).statusCode).toBe(403)
  })
})
