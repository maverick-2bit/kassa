/**
 * Routen-Schutz — Prüfbericht 2026-11, Befund 3 („Berechtigungen nur im UI").
 *
 * Der Test baut den ganzen Server, sammelt jede registrierte Route samt ihren Wächtern (server.ts → routenRegister) und
 * prüft sie gegen die Rechte-Tabelle (src/auth/route-rechte.ts):
 *   - jede Route ist entweder ausdrücklich öffentlich, hat einen Wächter oder steht mit Begründung als „jeder Angemeldete" in der Tabelle;
 *   - die Tabelle kennt keine Route, die es nicht mehr gibt, und keine Route doppelt;
 *   - die Wächter wirken über HTTP: ohne Token 401, mit Kellner-Token ohne das nötige Recht 403.
 *
 * Wer eine neue Route anlegt und sie nicht in die Tabelle einträgt, bekommt hier einen roten Test mit dem Hinweis dazu.
 * Der Test braucht keine Datenbank: Verweigerte Aufrufe enden im Wächter, bevor ein Handler läuft.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALLE_BERECHTIGUNGEN, type Berechtigung } from '@kassa/shared'
import type { Db } from '../src/db/client.js'
import type { RoutenEintrag } from '../src/server.js'
import { OEFFENTLICHE_ROUTEN, ROUTEN_RECHTE, tabellenSchluessel, zugriffFuerRoute } from '../src/auth/route-rechte.js'
import { waechterVon, type Waechter } from '../src/auth/waechter.js'
import { buildTestServer, type TestServer } from './helpers/testServer.js'

interface Route {
  schluessel: string
  methode:    string
  url:        string
  waechter:   Waechter[]
}

const EINTRAGEN = 'Eintragen in packages/backend/src/auth/route-rechte.ts'
const UUID = '00000000-0000-4000-8000-0000000000aa'

let ts: TestServer
let routen: Route[] = []

beforeAll(async () => {
  const register: RoutenEintrag[] = []
  ts = await buildTestServer({} as Db, { routenRegister: register })
  // HEAD bleibt drin: Fastify legt es zu jedem GET selbst an und führt den GET-Handler aus — es muss genauso geschützt sein
  routen = register.flatMap(r =>
    (Array.isArray(r.method) ? r.method : [r.method])
      .filter(m => m !== 'OPTIONS')
      .map(m => ({ schluessel: `${m} ${r.url}`, methode: m, url: r.url, waechter: waechterVon(r.onRequest) })),
  )
})

afterAll(async () => { await ts.close() })

const konkret = (url: string) => url.replace(/:[A-Za-z0-9_]+/g, UUID)
const ohneRecht = (diese: readonly Berechtigung[]): Berechtigung[] => ALLE_BERECHTIGUNGEN.filter(b => !diese.includes(b))
const sortiert = (l: readonly string[]) => [...l].sort().join(',')

describe('Routen-Inventur: jede Route ist geschützt oder ausdrücklich öffentlich', () => {
  it('der Server registriert Routen (Test läuft nicht ins Leere)', () => {
    expect(routen.length).toBeGreaterThan(300)
  })

  it('keine Route ohne Entscheidung', () => {
    const oeffentlich = new Set(OEFFENTLICHE_ROUTEN.flatMap(([, liste]) => liste))
    const probleme: string[] = []

    for (const r of routen) {
      const tabelle = zugriffFuerRoute(r.methode, r.url)
      const rechtWaechter = r.waechter.filter(w => w.art !== 'angemeldet')
      const istOeffentlich = oeffentlich.has(tabellenSchluessel(r.methode, r.url))

      if (r.waechter.length === 0) {
        if (!istOeffentlich) {
          probleme.push(`${r.schluessel}: hat keinen Wächter und steht nicht als öffentlich in OEFFENTLICHE_ROUTEN. ${EINTRAGEN} (mit Begründung, wer die Route schützt) oder einen Wächter anhängen.`)
        }
        continue
      }
      if (istOeffentlich) {
        probleme.push(`${r.schluessel}: steht als öffentlich in OEFFENTLICHE_ROUTEN, hat aber einen Wächter — Eintrag streichen.`)
      }
      if (rechtWaechter.length === 0) {
        // Nur angemeldet: das ist nur mit ausdrücklicher Begründung erlaubt
        if (tabelle?.art !== 'jeder') {
          probleme.push(`${r.schluessel}: verlangt nur eine Anmeldung. ${EINTRAGEN}: das nötige Recht (ROUTEN_RECHTE) — oder, wenn wirklich jeder Angemeldete sie braucht, mit jeder('Begründung').`)
        }
      } else if (tabelle?.art === 'jeder') {
        probleme.push(`${r.schluessel}: Tabelle sagt „jeder Angemeldete", die Route hat aber einen Rechte-Wächter.`)
      }
    }

    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('die Tabelle stimmt mit den tatsächlichen Wächtern überein', () => {
    const probleme: string[] = []
    for (const r of routen) {
      const tabelle = zugriffFuerRoute(r.methode, r.url)
      if (!tabelle || tabelle.art === 'jeder') continue

      if (tabelle.art === 'berechtigung') {
        const w = r.waechter.find(x => x.art === 'berechtigung')
        if (!w || w.art !== 'berechtigung' || sortiert(w.berechtigungen) !== sortiert(tabelle.berechtigungen)) {
          probleme.push(`${r.schluessel}: Tabelle verlangt ${tabelle.berechtigungen.join(' oder ')}, die Route schützt anders (${JSON.stringify(r.waechter)}).`)
        }
      } else if (!r.waechter.some(x => x.art === 'rolle' && x.rollen.includes('admin') && x.rollen.length === 1)) {
        probleme.push(`${r.schluessel}: Tabelle verlangt die Rolle admin, die Route schützt anders (${JSON.stringify(r.waechter)}).`)
      }
    }
    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('jede HEAD-Route ist genauso geschützt wie ihr GET (Fastify führt für HEAD den GET-Handler aus)', () => {
    const gets = new Map(routen.filter(r => r.methode === 'GET').map(r => [r.url, r]))
    const heads = routen.filter(r => r.methode === 'HEAD')
    expect(heads.length, 'HEAD-Routen werden mitgeprüft').toBeGreaterThan(100)

    const probleme: string[] = []
    for (const h of heads) {
      const g = gets.get(h.url)
      if (!g) { probleme.push(`${h.schluessel}: kein passendes GET`); continue }
      if (JSON.stringify(h.waechter) !== JSON.stringify(g.waechter)) {
        probleme.push(`${h.schluessel}: Wächter ${JSON.stringify(h.waechter)} statt wie GET ${JSON.stringify(g.waechter)}`)
      }
    }
    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('die Tabellen kennen keine Route, die es nicht gibt, und keine doppelt', () => {
    const vorhanden = new Set(routen.map(r => r.schluessel))
    const probleme: string[] = []
    const gesehen = new Map<string, string>()

    for (const [zugriff, liste] of ROUTEN_RECHTE) {
      for (const k of liste) {
        if (!vorhanden.has(k)) probleme.push(`ROUTEN_RECHTE: „${k}" gibt es nicht (mehr) — streichen oder Schreibweise prüfen.`)
        if (gesehen.has(k)) probleme.push(`„${k}" steht doppelt (ROUTEN_RECHTE).`)
        gesehen.set(k, zugriff.art)
      }
    }
    for (const [, liste] of OEFFENTLICHE_ROUTEN) {
      for (const k of liste) {
        if (!vorhanden.has(k)) probleme.push(`OEFFENTLICHE_ROUTEN: „${k}" gibt es nicht (mehr) — streichen oder Schreibweise prüfen.`)
        if (gesehen.has(k)) probleme.push(`„${k}" steht in ROUTEN_RECHTE und in OEFFENTLICHE_ROUTEN.`)
      }
    }
    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('jede Ausnahme „jeder Angemeldete" und jede öffentliche Route hat eine Begründung', () => {
    for (const [zugriff] of ROUTEN_RECHTE) {
      if (zugriff.art === 'jeder') expect(zugriff.grund.trim().length, 'Begründung fehlt oder ist zu kurz').toBeGreaterThanOrEqual(40)
    }
    for (const [grund, liste] of OEFFENTLICHE_ROUTEN) {
      expect(grund.trim().length, 'Begründung fehlt oder ist zu kurz').toBeGreaterThanOrEqual(30)
      expect(liste.length).toBeGreaterThan(0)
    }
  })
})

describe('Die Wächter wirken über HTTP', () => {
  const geschuetzt = () => routen.filter(r => r.waechter.some(w => w.art === 'berechtigung' || w.art === 'rolle'))

  it('ohne Token: 401 auf jeder Route mit Recht-/Rollen-Wächter', async () => {
    const probleme: string[] = []
    for (const r of geschuetzt()) {
      const res = await ts.fastify.inject({ method: r.methode as 'GET', url: konkret(r.url) })
      if (res.statusCode !== 401) probleme.push(`${r.schluessel}: ohne Token ${res.statusCode} statt 401`)
    }
    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('Kellner ohne das nötige Recht: 403 (Recht-Wächter) bzw. Admin-Rolle verlangt (Rollen-Wächter)', async () => {
    const probleme: string[] = []
    for (const r of geschuetzt()) {
      const berechtigung = r.waechter.find(w => w.art === 'berechtigung')
      const rolle        = r.waechter.find(w => w.art === 'rolle')
      // Kellner mit ALLEN Rechten, die diese Route NICHT akzeptiert; bei Rollen-Wächtern mit allen Rechten überhaupt
      const rechte = berechtigung?.art === 'berechtigung' ? ohneRecht(berechtigung.berechtigungen) : [...ALLE_BERECHTIGUNGEN]
      const res = await ts.fastify.inject({
        method:  r.methode as 'GET',
        url:     konkret(r.url),
        headers: ts.authHeader({ rolle: 'kellner', berechtigungen: rechte }),
      })
      if (res.statusCode !== 403) {
        probleme.push(`${r.schluessel}: Kellner ohne ${berechtigung?.art === 'berechtigung' ? berechtigung.berechtigungen.join('/') : `Rolle ${rolle?.art === 'rolle' ? rolle.rollen.join('/') : '?'}`} bekommt ${res.statusCode} statt 403`)
      }
    }
    expect(probleme, probleme.join('\n')).toEqual([])
  })

  it('jedes einzelne der genannten Rechte genügt („oder"), ein anderes nicht', async () => {
    // POST /api/belege/:id/email verlangt tische ODER kasse ODER belege.lesen
    const anfrage = (berechtigungen: Berechtigung[]) => ts.fastify.inject({
      method: 'POST', url: `/api/belege/${UUID}/email`, payload: {},
      headers: ts.authHeader({ rolle: 'kellner', berechtigungen }),
    })
    for (const b of ['tische', 'kasse', 'belege.lesen'] as const) {
      expect((await anfrage([b])).statusCode, `mit ${b}`).not.toBe(403)
    }
    expect((await anfrage(['artikel.verwalten'])).statusCode).toBe(403)
    expect((await anfrage([])).statusCode).toBe(403)
  })

  it('Admin besteht jeden Rechte-Wächter, auch ohne Einträge im Token', async () => {
    const res = await ts.fastify.inject({
      method: 'POST', url: '/api/gutscheine', payload: {},
      headers: ts.authHeader({ rolle: 'admin', berechtigungen: [] }),
    })
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).not.toBe(401)
  })

  it('Gutscheine ausstellen braucht das Recht „Schnellkasse" (Befund 3: vorher reichte jede Anmeldung)', async () => {
    const mit = await ts.fastify.inject({
      method: 'POST', url: '/api/gutscheine', payload: {},
      headers: ts.authHeader({ rolle: 'kellner', berechtigungen: ['kasse'] }),
    })
    expect(mit.statusCode).not.toBe(403)
    const ohne = await ts.fastify.inject({
      method: 'POST', url: '/api/gutscheine', payload: {},
      headers: ts.authHeader({ rolle: 'kellner', berechtigungen: ['tische', 'belege.lesen'] }),
    })
    expect(ohne.statusCode).toBe(403)
    expect(ohne.json()).toEqual({ fehler: 'Keine Berechtigung' })
  })

  it('Kreditverkauf (offener Posten) braucht „Kreditverkauf", nicht nur „Schnellkasse"', async () => {
    const ohne = await ts.fastify.inject({
      method: 'POST', url: '/api/offene-posten', payload: {},
      headers: ts.authHeader({ rolle: 'kellner', berechtigungen: ['kasse'] }),
    })
    expect(ohne.statusCode).toBe(403)
    const mit = await ts.fastify.inject({
      method: 'POST', url: '/api/offene-posten', payload: {},
      headers: ts.authHeader({ rolle: 'kellner', berechtigungen: ['kasse.kredit'] }),
    })
    expect(mit.statusCode).not.toBe(403)
  })

  it('Geräte-Token (KDS) zählen nie als Recht — auch nicht auf Recht-geschützten Routen', async () => {
    const kds = ts.fastify.jwt.sign({
      sub: 'kds-geraet', mandantId: '10000000-0000-0000-0000-000000000001', rolle: 'admin', name: 'KDS', berechtigungen: [], typ: 'kds_geraet',
    })
    const kopf = { authorization: `Bearer ${kds}` }
    // Routen aus der Tabelle: hier verweigert schon `authenticate` (Gerät nur für /api/kds/), der Recht-Wächter kommt danach …
    expect((await ts.fastify.inject({ method: 'GET', url: '/api/audit-log', headers: kopf })).statusCode).toBe(403)
    // … Ticketing-Routen haben NUR den Recht-Wächter: er selbst muss das Gerät abweisen (Admin-Rolle im Token zählt nicht)
    expect((await ts.fastify.inject({ method: 'GET', url: '/api/ticketing/events', headers: kopf })).statusCode).toBe(403)
  })

  it('HEAD umgeht den Wächter nicht (vorher lief HEAD /api/berichte/umsatz als Kellner bis in den Handler)', async () => {
    const kellner = ts.authHeader({ rolle: 'kellner', berechtigungen: ['tische', 'kasse'] })
    for (const url of ['/api/berichte/umsatz', '/api/export/bmd', '/api/artikel/layout-export', '/api/ticketing/events']) {
      expect((await ts.fastify.inject({ method: 'HEAD', url, headers: kellner })).statusCode, `HEAD ${url} als Kellner`).toBe(403)
      expect((await ts.fastify.inject({ method: 'HEAD', url })).statusCode, `HEAD ${url} ohne Token`).toBe(401)
    }
  })

  it('Berichte, Exporte und Prüfer-Link sind für Kellner ohne Berichts-/Einstellungsrecht gesperrt', async () => {
    const kellner = ts.authHeader({ rolle: 'kellner', berechtigungen: ['tische', 'kasse'] })
    const gesperrt = [
      'GET /api/berichte/umsatz',
      'GET /api/export/bmd',
      'POST /api/finanzpruefung/tokens',
      'POST /api/belege/monatsbeleg',
      'POST /api/belege/jahresbeleg',
      'POST /api/belege/storno',
      'POST /api/belege/see-ausfall',
      'POST /api/artikel',
      'PUT /api/artikel/:id',
      'DELETE /api/kategorien/:id',
      'PATCH /api/mandanten/stripe',
    ]
    for (const eintrag of gesperrt) {
      const [methode, url] = eintrag.split(' ') as [string, string]
      const res = await ts.fastify.inject({ method: methode as 'GET', url: konkret(url), headers: kellner })
      expect(res.statusCode, eintrag).toBe(403)
    }
  })
})
