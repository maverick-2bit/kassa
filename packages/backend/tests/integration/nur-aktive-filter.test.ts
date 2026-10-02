/**
 * Integrationstest: `nurAktive`-Filter der Stammdaten-Listen gegen echtes PostgreSQL.
 *
 * Regressions-Guard für den Query-Parser: `z.coerce.boolean()` machte aus dem
 * Query-String "false" den Wert true (Boolean("false") === true). Dadurch lieferte
 * `?nurAktive=false` nur aktive Einträge — deaktivierte Artikel und Warengruppen
 * waren im Backoffice unsichtbar und ließen sich nicht reaktivieren.
 *
 * Zusätzlich: ohne Aktiv-Filter bleibt die Mandanten-Trennung bestehen (kein Eintrag
 * eines fremden Mandanten, auch kein deaktivierter).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const PASSWORT = 'nuraktive-passwort-123'
const email    = (nr: number) => `admin${nr}@nuraktive.at`

const setupInput = (nr: number) => ({
  firmenname: `Filterwirt ${nr} GmbH`,
  uid:        `ATU9999991${nr}`,
  kassenId:   `FW-00${nr}`,
  finanzOnline: { teilnehmerId: `TID-FW-${nr}`, benutzerkennung: `BID-FW-${nr}`, pin: `PIN-FW-${nr}` },
  umgebung: 'test',
  admin: { name: `FW Admin ${nr}`, email: email(nr), passwort: PASSWORT },
})

interface Eintrag { id: string; aktiv: boolean; [feld: string]: unknown }

describe('nurAktive-Filter (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<number, string> = {}

  const auth = (nr = 1) => ({ authorization: `Bearer ${token[nr]}` })

  async function liste(url: string, nr = 1): Promise<Eintrag[]> {
    const res = await srv.fastify.inject({ method: 'GET', url, headers: auth(nr) })
    if (res.statusCode !== 200) throw new Error(`GET ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as Eintrag[]
  }
  const ids = (eintraege: Eintrag[]) => eintraege.map(e => e.id)
  /** Alles außer dem Änderungszeitpunkt — der ändert sich bei jedem Schreiben */
  const ohneZeitstempel = ({ updatedAt: _u, ...rest }: Eintrag) => rest

  /**
   * „Reaktivieren" schickt ein Teil-Update (nur aktiv): Deaktivieren und Reaktivieren dürfen
   * nichts anderes am Eintrag verändern (keine Schema-Vorgaben, die Felder zurücksetzen).
   */
  async function deaktivierenUndReaktivieren(listenUrl: string, einzelUrl: string, id: string): Promise<void> {
    const holen = async () => (await liste(listenUrl)).find(e => e.id === id)!
    const vorher = await holen()
    expect(vorher.aktiv).toBe(true)

    await deaktiviere(einzelUrl)
    expect((await holen()).aktiv).toBe(false)

    const put = await srv.fastify.inject({ method: 'PUT', url: einzelUrl, headers: auth(), payload: { aktiv: true } })
    expect(put.statusCode).toBe(200)
    expect(ohneZeitstempel(await holen())).toEqual(ohneZeitstempel(vorher))
  }

  async function legeAn(url: string, payload: object, nr = 1): Promise<string> {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(nr), payload })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json().id as string
  }
  async function deaktiviere(url: string, nr = 1): Promise<void> {
    const res = await srv.fastify.inject({ method: 'DELETE', url, headers: auth(nr) })
    if (res.statusCode !== 200) throw new Error(`DELETE ${url} (${res.statusCode}): ${res.body}`)
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2]) {
      const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setupRes.statusCode !== 201) throw new Error(`Setup ${nr} (${setupRes.statusCode}): ${setupRes.body}`)
      const login = (await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: email(nr), passwort: PASSWORT },
      })).json()
      token[nr] = login.token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('GET /api/artikel', () => {
    let aktivId = ''
    let deaktiviertId = ''
    let fremdDeaktiviertId = ''

    beforeAll(async () => {
      aktivId       = await legeAn('/api/artikel', { bezeichnung: 'Almdudler',     preisBruttoCent: 390, mwstSatz: 'normal' })
      deaktiviertId = await legeAn('/api/artikel', { bezeichnung: 'Sommerspritzer', preisBruttoCent: 390, mwstSatz: 'normal' })
      await deaktiviere(`/api/artikel/${deaktiviertId}`)
      // Fremder Mandant: auch dessen deaktivierter Artikel darf nie auftauchen
      fremdDeaktiviertId = await legeAn('/api/artikel', { bezeichnung: 'Fremdartikel', preisBruttoCent: 100, mwstSatz: 'normal' }, 2)
      await deaktiviere(`/api/artikel/${fremdDeaktiviertId}`, 2)
    })

    it('?nurAktive=false findet den deaktivierten Artikel, ?nurAktive=true nicht', async () => {
      const alle = await liste('/api/artikel?nurAktive=false')
      expect(ids(alle)).toEqual(expect.arrayContaining([aktivId, deaktiviertId]))
      expect(alle.find(a => a.id === deaktiviertId)?.aktiv).toBe(false)

      const aktive = await liste('/api/artikel?nurAktive=true')
      expect(ids(aktive)).toContain(aktivId)
      expect(ids(aktive)).not.toContain(deaktiviertId)
      expect(aktive.every(a => a.aktiv)).toBe(true)
    })

    it('ohne Parameter bleibt der Standard „nur aktive"', async () => {
      const standard = await liste('/api/artikel')
      expect(ids(standard)).toContain(aktivId)
      expect(ids(standard)).not.toContain(deaktiviertId)
    })

    it('das Frontend schickt mandantId mit — das ändert weder Filter noch Mandant', async () => {
      const alle = await liste('/api/artikel?mandantId=00000000-0000-0000-0000-00000000dead&nurAktive=false')
      expect(ids(alle)).toEqual(expect.arrayContaining([aktivId, deaktiviertId]))
    })

    it('ohne Aktiv-Filter bleibt die Mandanten-Trennung bestehen', async () => {
      expect(ids(await liste('/api/artikel?nurAktive=false'))).not.toContain(fremdDeaktiviertId)
      expect(ids(await liste('/api/artikel?nurAktive=false', 2))).toEqual([fremdDeaktiviertId])
    })

    it.each(['nein', '1', ''])('ungültiger Wert %j → 400 statt stiller Umdeutung', async (wert) => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/artikel?nurAktive=${wert}`, headers: auth() })
      expect(res.statusCode).toBe(400)
    })

    it('reaktivierter Artikel erscheint wieder unter ?nurAktive=true', async () => {
      const put = await srv.fastify.inject({
        method: 'PUT', url: `/api/artikel/${deaktiviertId}`, headers: auth(), payload: { aktiv: true },
      })
      expect(put.statusCode).toBe(200)
      expect(ids(await liste('/api/artikel?nurAktive=true'))).toContain(deaktiviertId)
    })

    it('Deaktivieren und Reaktivieren verändern sonst nichts am Artikel', async () => {
      const gruppeId = await legeAn('/api/kategorien', { name: 'Reaktiv-Gruppe', farbe: 'grau', reihenfolge: 7 })
      const id = await legeAn('/api/artikel', {
        bezeichnung: 'Reaktiv-Artikel', preisBruttoCent: 420, mwstSatz: 'ermaessigt1', kategorieId: gruppeId,
        istFavorit: true, lagerstandAktiv: true, lagerstandMenge: 7,
      })
      await deaktivierenUndReaktivieren('/api/artikel?nurAktive=false', `/api/artikel/${id}`, id)
    })
  })

  describe('GET /api/kategorien', () => {
    let aktivId = ''
    let deaktiviertId = ''
    let fremdDeaktiviertId = ''

    beforeAll(async () => {
      aktivId       = await legeAn('/api/kategorien', { name: 'Alkoholfrei', farbe: 'blau', reihenfolge: 0 })
      deaktiviertId = await legeAn('/api/kategorien', { name: 'Sommerkarte', farbe: 'blau', reihenfolge: 1 })
      await deaktiviere(`/api/kategorien/${deaktiviertId}`)
      fremdDeaktiviertId = await legeAn('/api/kategorien', { name: 'Fremdgruppe', farbe: 'rot', reihenfolge: 0 }, 2)
      await deaktiviere(`/api/kategorien/${fremdDeaktiviertId}`, 2)
    })

    it('?nurAktive=false findet die deaktivierte Warengruppe, ?nurAktive=true nicht', async () => {
      const alle = await liste('/api/kategorien?nurAktive=false')
      expect(ids(alle)).toEqual(expect.arrayContaining([aktivId, deaktiviertId]))
      expect(alle.find(k => k.id === deaktiviertId)?.aktiv).toBe(false)

      const aktive = await liste('/api/kategorien?nurAktive=true')
      expect(ids(aktive)).toContain(aktivId)
      expect(ids(aktive)).not.toContain(deaktiviertId)
      expect(aktive.every(k => k.aktiv)).toBe(true)
    })

    it('ohne Parameter bleibt der Standard „alle"', async () => {
      expect(ids(await liste('/api/kategorien'))).toEqual(expect.arrayContaining([aktivId, deaktiviertId]))
    })

    it('ohne Aktiv-Filter bleibt die Mandanten-Trennung bestehen', async () => {
      expect(ids(await liste('/api/kategorien?nurAktive=false'))).not.toContain(fremdDeaktiviertId)
      expect(ids(await liste('/api/kategorien?nurAktive=false', 2))).toEqual([fremdDeaktiviertId])
    })

    it.each(['nein', '1', ''])('ungültiger Wert %j → 400 statt stiller Umdeutung', async (wert) => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/kategorien?nurAktive=${wert}`, headers: auth() })
      expect(res.statusCode).toBe(400)
    })

    it('reaktivierte Warengruppe erscheint wieder unter ?nurAktive=true', async () => {
      const put = await srv.fastify.inject({
        method: 'PUT', url: `/api/kategorien/${deaktiviertId}`, headers: auth(), payload: { aktiv: true },
      })
      expect(put.statusCode).toBe(200)
      expect(ids(await liste('/api/kategorien?nurAktive=true'))).toContain(deaktiviertId)
    })

    it('Deaktivieren und Reaktivieren verändern sonst nichts an der Warengruppe', async () => {
      const elternId = await legeAn('/api/kategorien', { name: 'Reaktiv-Eltern', farbe: 'blau', reihenfolge: 3 })
      const id = await legeAn('/api/kategorien', {
        name: 'Reaktiv-Kind', farbe: 'rot', reihenfolge: 4, parentId: elternId, station: 'schank', terminalSichtbar: true,
      })
      await deaktivierenUndReaktivieren('/api/kategorien?nurAktive=false', `/api/kategorien/${id}`, id)
    })
  })
})
