/**
 * Integrationstest: RKSV-Signatur-Selbsttest gegen echtes PostgreSQL.
 *
 * Verifiziert die vier Status-Klassen des Selbsttests über die HTTP-Route:
 *  - gueltig:       regulär signierte Belege
 *  - der_altformat: Signatur nachträglich in das DER-Altformat umcodiert
 *                   (simuliert einen vor dem P1363-Fix erstellten Alt-Beleg)
 *  - ungueltig:     Signaturwert zerstört
 *  - ausfall:       SEE-Ausfallbeleg (Marker statt Signatur)
 * plus Kettenprüfung, CSV-Export (BOM + Zeilen) und den Admin-Guard.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { p1363ZuDer, type FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@selbsttest.at'
const ADMIN_PASSWORT = 'selbsttest-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ST-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Selbsttest GmbH',
  uid:        'ATU99999905',
  kassenId:   'ST-001',
  finanzOnline: { teilnehmerId: 'TID-ST', benutzerkennung: 'BID-ST', pin: 'PIN-ST' },
  umgebung: 'test',
  admin: { name: 'ST Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('RKSV-Signatur-Selbsttest (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })
  const selbsttest = async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/rksv/signatur-selbsttest?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const barzahlen = (cent: number) =>
    srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Bier', preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
      },
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    await barzahlen(1000)
    await barzahlen(2000)
    await barzahlen(3000)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('frische Kasse: alle Belege gültig, Kette geschlossen, Nummern lückenlos', async () => {
    const e = await selbsttest()
    expect(e.geprueft).toBeGreaterThanOrEqual(4) // Startbeleg + 3 Barzahlungen
    expect(e.gueltig).toBe(e.geprueft)
    expect(e.ausfall).toBe(0)
    expect(e.derAltformat).toBe(0)
    expect(e.ungueltig).toBe(0)
    expect(e.ketteOk).toBe(true)
    expect(e.nummernLueckenlos).toBe(true)
    expect(e.details).toHaveLength(0)
    expect(e.detailsGekappt).toBe(false)
  })

  it('DER-umcodierte Signatur wird als der_altformat erkannt (Alt-Beleg vor P1363-Fix)', async () => {
    // Beleg Nr. 2: P1363-Signatur (64 Byte) nachträglich in DER umcodieren —
    // exakt das Format, das der Signierpfad vor dem Fix gespeichert hat.
    const [row] = await idb.db.select().from(belege)
      .where(and(eq(belege.kasseId, kasseId), eq(belege.belegNummer, 2)))
    const derB64 = p1363ZuDer(Buffer.from(row!.signaturwert, 'base64')).toString('base64')
    await idb.db.update(belege).set({ signaturwert: derB64 }).where(eq(belege.id, row!.id))

    const e = await selbsttest()
    expect(e.derAltformat).toBe(1)
    expect(e.ungueltig).toBe(0)
    expect(e.gueltig).toBe(e.geprueft - 1)
    expect(e.details).toHaveLength(1)
    expect(e.details[0]).toMatchObject({ belegNummer: 2, status: 'der_altformat' })
    // Kette hängt am maschinenlesbaren Code — sie bleibt geschlossen
    expect(e.ketteOk).toBe(true)
  })

  it('zerstörte Signatur wird als ungueltig erkannt', async () => {
    const [row] = await idb.db.select().from(belege)
      .where(and(eq(belege.kasseId, kasseId), eq(belege.belegNummer, 3)))
    await idb.db.update(belege)
      .set({ signaturwert: randomBytes(64).toString('base64') })
      .where(eq(belege.id, row!.id))

    const e = await selbsttest()
    expect(e.ungueltig).toBe(1)
    expect(e.derAltformat).toBe(1)
    expect(e.details.map((d: { status: string }) => d.status).sort())
      .toEqual(['der_altformat', 'ungueltig'])
  })

  it('SEE-Ausfallbelege zählen als ausfall, nicht als ungueltig', async () => {
    await srv.fastify.inject({ method: 'POST', url: '/api/belege/see-ausfall', headers: auth(), payload: { kasseId } })
    await barzahlen(500) // trägt den Ausfallmarker
    await srv.fastify.inject({ method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId } })

    const e = await selbsttest()
    expect(e.ausfall).toBe(1)
    expect(e.ungueltig).toBe(1)      // unverändert aus dem Test davor
    expect(e.derAltformat).toBe(1)
    expect(e.ketteOk).toBe(true)     // Kette bleibt über den Ausfall geschlossen
    expect(e.nummernLueckenlos).toBe(true)
  })

  it('CSV-Export: BOM, Kopfzeile und alle auffälligen Belege', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/rksv/signatur-selbsttest.csv?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body.charCodeAt(0)).toBe(0xFEFF)
    const zeilen = res.body.slice(1).split('\r\n')
    expect(zeilen[0]).toBe('Belegnummer;Datum;Belegtyp;Status')
    expect(zeilen.length).toBe(1 + 3) // der_altformat + ungueltig + ausfall
    expect(res.body).toContain('Altformat DER')
    expect(res.body).toContain('UNGÜLTIG')
    expect(res.body).toContain('SEE-Ausfall')
  })

  it('Nicht-Admin → 403, fremde Kasse → 404', async () => {
    const verboten = await srv.fastify.inject({
      method: 'GET', url: `/api/rksv/signatur-selbsttest?kasseId=${kasseId}`,
      headers: { authorization: `Bearer ${srv.signTestToken({ rolle: 'kellner', berechtigungen: [] })}` },
    })
    expect(verboten.statusCode).toBe(403)

    const fremd = await srv.fastify.inject({
      method: 'GET', url: '/api/rksv/signatur-selbsttest?kasseId=00000000-0000-4000-8000-000000000000',
      headers: auth(),
    })
    expect(fremd.statusCode).toBe(404)
  })
})
