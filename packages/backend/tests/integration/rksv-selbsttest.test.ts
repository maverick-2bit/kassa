/**
 * Integrationstest: RKSV-Signatur-Selbsttest gegen echtes PostgreSQL.
 *
 * Verifiziert die Status-Klassen des Selbsttests über die HTTP-Route:
 *  - gueltig:        regulär signierte Belege
 *  - der_altformat:  Signatur nachträglich in das DER-Altformat umcodiert
 *                    (simuliert einen vor dem P1363-Fix erstellten Alt-Beleg)
 *  - zeit_altformat: Uhrzeit im QR-Code in UTC statt Wiener Ortszeit (simuliert einen in
 *                    einem Container ohne TZ signierten Beleg — gültig, aber 1–2 h daneben)
 *  - ungueltig:      Signaturwert zerstört
 *  - ausfall:        SEE-Ausfallbeleg (Marker statt Signatur)
 * plus Kettenprüfung, CSV-Export (BOM + Zeilen) und den Admin-Guard.
 *
 * Die Alt-Belege werden WIRKLICH nachgebaut (Code samt Signatur im Altformat, mit dem
 * echten Schlüssel der Kasse neu signiert): Der Selbsttest prüft gegen den gespeicherten
 * Code, ein nur am Signaturwert gedrehter Beleg wäre ein anderer Fall (Code ≠ Feld).
 * Damit die Kette geschlossen bleibt, wird dafür immer der LETZTE Beleg umgebaut und
 * `kassen.letzter_beleg_code` nachgezogen — so entstünde sie auch in einer alten Kasse.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import { jwsSigningInput, p1363ZuDer, signiereRoh, type FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, kassen } from '../../src/db/schema.js'
import { decryptPrivateKey } from '../../src/crypto/master-key.js'

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

  /**
   * Baut den LETZTEN Beleg der Kasse zu einem Altbeleg um: `bauCode` bekommt den Code ohne
   * Signatur und liefert die Altform; der Beleg wird neu signiert (echter Kassen-Schlüssel),
   * Spalten + `kassen.letzter_beleg_code` ziehen nach. Liefert die Belegnummer.
   */
  async function letztenBelegUmbauen(
    bauCode:    (codeOhneSig: string, row: typeof belege.$inferSelect) => string,
    signaturAlsDer = false,
  ): Promise<number> {
    const [row] = await idb.db.select().from(belege)
      .where(eq(belege.kasseId, kasseId)).orderBy(desc(belege.belegNummer)).limit(1)
    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    const privateKeyDER = decryptPrivateKey(kasse!.seePrivateKeyEnc, TEST_MASTER)

    const alterCode   = row!.maschinenlesbareCode
    const codeOhneSig = bauCode(alterCode.slice(0, alterCode.lastIndexOf('_')), row!)
    const roh         = signiereRoh(jwsSigningInput(codeOhneSig), { privateKeyDER })
    const signatur    = (signaturAlsDer ? p1363ZuDer(roh) : roh).toString('base64')
    const neuerCode   = `${codeOhneSig}_${signatur}`

    await idb.db.update(belege).set({ signaturwert: signatur, maschinenlesbareCode: neuerCode })
      .where(eq(belege.id, row!.id))
    await idb.db.update(kassen).set({ letzterBelegCode: neuerCode }).where(eq(kassen.id, kasseId))
    return row!.belegNummer
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
    expect(e.zeitAltformat).toBe(0)
    expect(e.ungueltig).toBe(0)
    expect(e.ketteOk).toBe(true)
    expect(e.nummernLueckenlos).toBe(true)
    expect(e.details).toHaveLength(0)
    expect(e.detailsGekappt).toBe(false)
  })

  it('DER-codierte Signatur im Code wird als der_altformat erkannt (Alt-Beleg vor P1363-Fix)', async () => {
    // Letzter Beleg: Signatur samt Code im DER-Format — exakt das, was der Signierpfad
    // vor dem Fix gespeichert hat (der Code trug die DER-Signatur).
    const nr = await letztenBelegUmbauen(code => code, true)

    const e = await selbsttest()
    expect(e.derAltformat).toBe(1)
    expect(e.ungueltig).toBe(0)
    expect(e.gueltig).toBe(e.geprueft - 1)
    expect(e.details).toHaveLength(1)
    expect(e.details[0]).toMatchObject({ belegNummer: nr, status: 'der_altformat' })
    // Kette hängt am maschinenlesbaren Code — sie bleibt geschlossen
    expect(e.ketteOk).toBe(true)
  })

  it('nur der Signaturwert auf DER gedreht, der gespeicherte Code unverändert: ungueltig (Spalte ≠ Code)', async () => {
    // Beleg Nr. 2: Spalte und QR-Code sind nicht mehr dasselbe — das ist kein Alt-Beleg,
    // sondern eine Abweichung, die die Prüfung gegen den gespeicherten Code aufdeckt.
    const [row] = await idb.db.select().from(belege)
      .where(and(eq(belege.kasseId, kasseId), eq(belege.belegNummer, 2)))
    const derB64 = p1363ZuDer(Buffer.from(row!.signaturwert, 'base64')).toString('base64')
    await idb.db.update(belege).set({ signaturwert: derB64 }).where(eq(belege.id, row!.id))

    const e = await selbsttest()
    expect(e.ungueltig).toBe(1)
    expect(e.details.find((d: { belegNummer: number }) => d.belegNummer === 2)).toMatchObject({ status: 'ungueltig' })

    // zurück auf den echten Wert, damit die folgenden Tests unverändert zählen
    await idb.db.update(belege).set({ signaturwert: row!.signaturwert }).where(eq(belege.id, row!.id))
    expect((await selbsttest()).ungueltig).toBe(0)
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

  it('Uhrzeit im QR-Code in UTC (Container ohne TZ): gültig, aber als zeit_altformat gemeldet — nicht als ungueltig', async () => {
    const vorher = await selbsttest()
    expect((await barzahlen(700)).statusCode).toBe(201)

    // Der neue Beleg trägt Wiener Ortszeit; so hätte ihn eine ältere Version in UTC signiert
    const nr = await letztenBelegUmbauen((codeOhneSig, row) => {
      const teile = codeOhneSig.split('_')
      expect(teile[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      teile[4] = row.belegDatum.toISOString().slice(0, 19)
      return teile.join('_')
    })

    const e = await selbsttest()
    expect(e.zeitAltformat).toBe(1)
    expect(e.ungueltig).toBe(vorher.ungueltig)               // nichts Neues „ungültig"
    expect(e.gueltig).toBe(vorher.gueltig)                    // der neue Beleg zählt als Altformat, nicht als gültig
    expect(e.details.find((d: { belegNummer: number }) => d.belegNummer === nr)).toMatchObject({ status: 'zeit_altformat' })
    expect(e.ketteOk).toBe(true)

    const csv = await srv.fastify.inject({
      method: 'GET', url: `/api/rksv/signatur-selbsttest.csv?kasseId=${kasseId}`, headers: auth(),
    })
    expect(csv.body).toContain('Uhrzeit im QR-Code in UTC statt Ortszeit')
  })

  it('der Zeitpunkt in der Datenbank wird mitgeprüft: ein verschobenes belegDatum fällt auf', async () => {
    // Beleg Nr. 1 (Startbeleg, Wiener Zeit im Code): Datum um einen Tag verschoben
    const [row] = await idb.db.select().from(belege)
      .where(and(eq(belege.kasseId, kasseId), eq(belege.belegNummer, 1)))
    await idb.db.update(belege)
      .set({ belegDatum: new Date(row!.belegDatum.getTime() + 24 * 3_600_000) })
      .where(eq(belege.id, row!.id))
    try {
      const e = await selbsttest()
      expect(e.details.find((d: { belegNummer: number }) => d.belegNummer === 1)).toMatchObject({ status: 'ungueltig' })
    } finally {
      await idb.db.update(belege).set({ belegDatum: row!.belegDatum }).where(eq(belege.id, row!.id))
    }
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
