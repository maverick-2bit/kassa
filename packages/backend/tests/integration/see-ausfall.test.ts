/**
 * Integrationstest: SEE-Ausfall + Wiederinbetriebnahme gegen echtes PostgreSQL.
 *
 * RKSV verlangt, dass bei Ausfall der Signaturerstellungseinheit Belege weiter
 * ausgegeben werden — mit dem Marker „Sicherheitseinrichtung ausgefallen" statt
 * einer Signatur — und bei Wiederinbetriebnahme ein signierter (Sammel-)Beleg
 * erstellt wird. Geprüft wird der komplette Lebenszyklus über die HTTP-Routen:
 *  - Normalbetrieb → signierte Belege
 *  - Ausfall melden → Belege tragen den Marker (nicht verifizierbar)
 *  - Status meldet Dauer
 *  - Wiederherstellung → signierter Sammelbeleg, Flag zurückgesetzt
 *  - danach wieder signierte Belege
 *  - die Signaturkette bleibt über den Ausfall hinweg lückenlos
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  pruefeKette,
  verifiziereBelegSignatur,
  istAusfallBeleg,
  SEE_AUSFALL_SIGNATUR,
  type VerifizierbarerBeleg,
  type FinanzOnlineClient,
} from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@see-ausfall.at'
const ADMIN_PASSWORT = 'see-ausfall-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SA-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'SEE-Ausfall GmbH',
  uid:        'ATU99999904',
  kassenId:   'SA-001',
  finanzOnline: { teilnehmerId: 'TID-SA', benutzerkennung: 'BID-SA', pin: 'PIN-SA' },
  umgebung: 'test',
  admin: { name: 'SA Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

function barzahlung(kasseId: string, preisBruttoCent: number) {
  return {
    kasseId,
    positionen: [{ bezeichnung: 'Bier', preisBruttoCent, mwstSatz: 'normal', menge: 1 }],
    zahlung: { barCent: preisBruttoCent, karteCent: 0, sonstigeCent: 0 },
  }
}

describe('SEE-Ausfall + Wiederinbetriebnahme (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let kassenKID: string
  let zertifikatDER: Buffer

  const auth = () => ({ authorization: `Bearer ${token}` })
  const barzahlen = (cent: number) =>
    srv.fastify.inject({ method: 'POST', url: '/api/belege/barzahlung', headers: auth(), payload: barzahlung(kasseId, cent) })

  function alsVerifizierbar(row: typeof belege.$inferSelect): VerifizierbarerBeleg {
    return {
      kassenId:     kassenKID,
      belegNummer:  row.belegNummer,
      datumUhrzeit: row.belegDatum,
      betraege: {
        normal:      row.betragNormalCent,
        ermaessigt1: row.betragErmaessigt1Cent,
        ermaessigt2: row.betragErmaessigt2Cent,
        null:        row.betragNullCent,
        besonders:   row.betragBesondersCent,
      },
      umsatzzaehlerVerschluesselt: row.umsatzzaehlerVerschluesselt,
      zertifikatSN:                row.zertifikatSn,
      sigVorbeleg:                 row.sigVorbeleg,
      signaturwert:                row.signaturwert,
    }
  }

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

    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    kassenKID     = kasse!.kassenId
    zertifikatDER = Buffer.from(kasse!.seeZertifikatDer, 'base64')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Normalbetrieb: Beleg ist signiert und verifizierbar', async () => {
    const res = await barzahlen(1000)
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(false)

    const [row] = await idb.db.select().from(belege).where(eq(belege.id, beleg.id))
    expect(verifiziereBelegSignatur(alsVerifizierbar(row!), zertifikatDER)).toBe(true)
  })

  it('Ausfall melden: Status wird ausgefallen, Belege tragen den Marker', async () => {
    const meld = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/see-ausfall', headers: auth(), payload: { kasseId },
    })
    expect(meld.statusCode).toBe(200)
    expect(meld.json().ausgefallen).toBe(true)

    const res = await barzahlen(2000)
    expect(res.statusCode).toBe(201)
    const beleg = res.json() as BelegResponse
    // Beleg existiert, trägt aber den BMF-Ausfallmarker statt einer Signatur
    expect(beleg.signaturwert).toBe(SEE_AUSFALL_SIGNATUR)
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(true)

    const [row] = await idb.db.select().from(belege).where(eq(belege.id, beleg.id))
    expect(verifiziereBelegSignatur(alsVerifizierbar(row!), zertifikatDER)).toBe(false)
    // Umsatzzähler läuft trotzdem weiter (Betrag ist gebucht)
    expect(row!.betragNormalCent).toBe(2000)
  })

  it('Ausfall ist idempotent und ein zweiter Beleg trägt ebenfalls den Marker', async () => {
    const erneut = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/see-ausfall', headers: auth(), payload: { kasseId },
    })
    expect(erneut.statusCode).toBe(200)

    const res = await barzahlen(500)
    expect((res.json() as BelegResponse).signaturwert).toBe(SEE_AUSFALL_SIGNATUR)
  })

  it('Status meldet den aktiven Ausfall', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/belege/see-status?kasseId=${kasseId}`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const status = res.json()
    expect(status.ausgefallen).toBe(true)
    expect(status.seit).toBeTruthy()
    expect(status.dauerMinuten).toBeGreaterThanOrEqual(0)
  })

  it('Wiederinbetriebnahme: signierter Sammelbeleg, Flag zurückgesetzt', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId },
    })
    expect(res.statusCode).toBe(201)
    const ergebnis = res.json()
    expect(ergebnis.behobenerAusfall.ausgefallen).toBe(true) // Status VOR der Behebung
    expect(ergebnis.sammelbeleg.belegTyp).toBe('Nullbeleg')

    // Der Sammelbeleg ist echt signiert
    const [row] = await idb.db.select().from(belege).where(eq(belege.id, ergebnis.sammelbeleg.id))
    expect(istAusfallBeleg(row!.signaturwert)).toBe(false)
    expect(verifiziereBelegSignatur(alsVerifizierbar(row!), zertifikatDER)).toBe(true)

    // Status ist wieder „in Betrieb"
    const status = (await srv.fastify.inject({
      method: 'GET', url: `/api/belege/see-status?kasseId=${kasseId}`, headers: auth(),
    })).json()
    expect(status.ausgefallen).toBe(false)
  })

  it('Wiederherstellung ohne aktiven Ausfall wird abgelehnt', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/see-wiederherstellung', headers: auth(), payload: { kasseId },
    })
    expect(res.statusCode).toBe(409)
  })

  it('nach der Wiederherstellung sind Belege wieder signiert', async () => {
    const beleg = (await barzahlen(750)).json() as BelegResponse
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(false)
    const [row] = await idb.db.select().from(belege).where(eq(belege.id, beleg.id))
    expect(verifiziereBelegSignatur(alsVerifizierbar(row!), zertifikatDER)).toBe(true)
  })

  it('die Signaturkette bleibt über den gesamten Ausfall hinweg lückenlos', async () => {
    const rows = (await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)))
      .sort((a, b) => a.belegNummer - b.belegNummer)

    // lückenlose Belegnummern
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.belegNummer).toBe(rows[i - 1]!.belegNummer + 1)
    }
    // Verkettung der Signaturwerte (Marker zählt als Signaturwert) ist geschlossen
    expect(pruefeKette(rows.map(r => ({ signaturwert: r.signaturwert, sigVorbeleg: r.sigVorbeleg })))).toBe(true)

    // genau zwei Belege tragen den Ausfallmarker
    expect(rows.filter(r => istAusfallBeleg(r.signaturwert))).toHaveLength(2)
  })
})
