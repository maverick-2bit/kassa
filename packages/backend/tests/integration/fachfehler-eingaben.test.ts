/**
 * Integrationstest: Eingabefehler kommen als Fachfehler an, nicht als 500 (echtes PostgreSQL).
 *
 * Befund 2026-09-24 (globaler Fehler-Handler): Der Handler gibt nur Fachfehler
 * (Error mit httpStatus) mit Status und Meldung weiter, alles andere wird
 * 500 „Interner Serverfehler". Zwei Eingabefehler des Admins landeten dort:
 *  - PUT /api/users/:id mit einer schon vergebenen E-Mail: updateUser prüfte
 *    nicht vorab (createUser schon), erst der Unique-Index users_email_idx
 *    meldete die Kollision
 *  - POST/PUT /api/artikel mit einem Bestandteil, der nicht zum Mandanten
 *    gehört: schreibeRezept warf einen plain Error
 *
 * Kernpunkte:
 *  - E-Mail vergeben → 409 { fehler: 'E-Mail bereits vergeben' }: kleingeschrieben
 *    verglichen, über alle Mandanten (Login per E-Mail), die eigene zählt nicht
 *  - fremder oder unbekannter Bestandteil → 400 mit Meldung, und die Transaktion
 *    rollt zurück: kein halb angelegter Artikel, das alte Rezept bleibt
 */

import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'FF-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const PASSWORT = 'fachfehler-passwort-1'

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Fachfehler ${nr} OG`,
    uid:        `ATU9999995${nr}`,
    kassenId:   `FF-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-FF-${nr}`, benutzerkennung: `BID-FF-${nr}`, pin: `PIN-FF-${nr}` },
    umgebung: 'test',
    admin: { name: `FF Admin ${nr}`, email: `admin${nr}@fachfehler.at`, passwort: PASSWORT },
  }
}

interface UserDto    { id: string; name: string; email: string }
interface ArtikelDto {
  id:           string
  bezeichnung:  string
  bestandteile: { bestandteilArtikelId: string; bezeichnung: string; menge: number }[]
}

describe('Eingabefehler als Fachfehler statt 500 (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  const token: Record<1 | 2, string> = { 1: '', 2: '' }

  /** Mandant 1 ist der handelnde Betrieb, Mandant 2 der fremde. */
  const auth = (nr: 1 | 2 = 1) => ({ authorization: `Bearer ${token[nr]}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const setup = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput(nr) })
      if (setup.statusCode !== 201) throw new Error(`Setup ${nr} (${setup.statusCode}): ${setup.body}`)
      const login = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@fachfehler.at`, passwort: PASSWORT },
      })
      if (login.statusCode !== 200) throw new Error(`Login ${nr} (${login.statusCode}): ${login.body}`)
      token[nr] = login.json().token
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('PUT /api/users/:id mit schon vergebener E-Mail', () => {
    let kellnerId = ''

    async function legeKellnerAn(name: string, email: string): Promise<string> {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: auth(),
        payload: { name, email, passwort: PASSWORT, rolle: 'kellner', berechtigungen: ['kasse'], kassenIds: [] },
      })
      if (res.statusCode !== 201) throw new Error(`Kellner ${name} (${res.statusCode}): ${res.body}`)
      return res.json().id
    }
    async function benutzer(id: string): Promise<UserDto | undefined> {
      const res = await srv.fastify.inject({ method: 'GET', url: '/api/users', headers: auth() })
      return (res.json() as UserDto[]).find(u => u.id === id)
    }
    const aendere = (id: string, payload: object) =>
      srv.fastify.inject({ method: 'PUT', url: `/api/users/${id}`, headers: auth(), payload })

    beforeAll(async () => {
      await legeKellnerAn('Kellner Eins', 'eins@fachfehler.at')
      kellnerId = await legeKellnerAn('Kellner Zwei', 'zwei@fachfehler.at')
    })

    it('E-Mail eines anderen Benutzers, anders geschrieben: 409, nichts geändert', async () => {
      const res = await aendere(kellnerId, { name: 'Umbenannt', email: 'Eins@Fachfehler.AT' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ fehler: 'E-Mail bereits vergeben' })
      expect(await benutzer(kellnerId)).toMatchObject({ name: 'Kellner Zwei', email: 'zwei@fachfehler.at' })
    })

    it('E-Mail aus einem anderen Mandanten: 409, Login-E-Mails sind mandantenübergreifend eindeutig', async () => {
      const res = await aendere(kellnerId, { email: 'admin2@fachfehler.at' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ fehler: 'E-Mail bereits vergeben' })
    })

    it('die eigene E-Mail, anders geschrieben, mitschicken: 200', async () => {
      const res = await aendere(kellnerId, { name: 'Kellner 2', email: 'ZWEI@fachfehler.at' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ name: 'Kellner 2', email: 'zwei@fachfehler.at' })
    })
  })

  describe('POST/PUT /api/artikel mit Bestandteil, der nicht zum Mandanten gehört', () => {
    const FEHLER = { fehler: 'Mindestens ein Bestandteil-Artikel gehört nicht zum Mandanten' }
    let rohId       = ''  // Mandant 1: Rohstoff
    let schnitzelId = ''  // Mandant 1: Verkaufsartikel, Rezept 2× Rohstoff
    let fremdId     = ''  // Mandant 2: Rohstoff

    async function legeArtikelAn(nr: 1 | 2, payload: object): Promise<string> {
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/artikel', headers: auth(nr), payload })
      if (res.statusCode !== 201) throw new Error(`Artikel (${res.statusCode}): ${res.body}`)
      return res.json().id
    }
    async function artikelListe(): Promise<ArtikelDto[]> {
      const res = await srv.fastify.inject({ method: 'GET', url: '/api/artikel', headers: auth() })
      return res.json() as ArtikelDto[]
    }

    beforeAll(async () => {
      rohId = await legeArtikelAn(1, {
        bezeichnung: 'Schnitzel roh', preisBruttoCent: 0, mwstSatz: 'normal', istBestandteil: true,
      })
      schnitzelId = await legeArtikelAn(1, {
        bezeichnung: 'Wiener Schnitzel', preisBruttoCent: 1500, mwstSatz: 'normal',
        bestandteile: [{ bestandteilArtikelId: rohId, menge: 2 }],
      })
      fremdId = await legeArtikelAn(2, {
        bezeichnung: 'Fremder Rohstoff', preisBruttoCent: 0, mwstSatz: 'normal', istBestandteil: true,
      })
    })

    it('POST mit unbekannter Bestandteil-ID: 400, kein Artikel angelegt', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/artikel', headers: auth(),
        payload: {
          bezeichnung: 'Phantom-Toast', preisBruttoCent: 450, mwstSatz: 'normal',
          bestandteile: [{ bestandteilArtikelId: randomUUID(), menge: 1 }],
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual(FEHLER)
      expect((await artikelListe()).map(a => a.bezeichnung)).not.toContain('Phantom-Toast')
    })

    it('PUT mit Artikel eines fremden Mandanten im Rezept: 400, Artikel und Rezept unverändert', async () => {
      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/artikel/${schnitzelId}`, headers: auth(),
        payload: {
          bezeichnung: 'Schnitzel neu',
          bestandteile: [
            { bestandteilArtikelId: rohId,   menge: 1 },
            { bestandteilArtikelId: fremdId, menge: 1 },
          ],
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual(FEHLER)

      // schreibeRezept löscht zuerst das alte Rezept — der Fehler rollt das mit zurück
      const schnitzel = (await artikelListe()).find(a => a.id === schnitzelId)
      expect(schnitzel?.bezeichnung).toBe('Wiener Schnitzel')
      expect(schnitzel?.bestandteile).toEqual([{ bestandteilArtikelId: rohId, bezeichnung: 'Schnitzel roh', menge: 2 }])
    })
  })
})
