/**
 * Integrationstest: Signatur-Selbsttest und BESTEHENDE KETTEN (Befund A der RKSV-Prüfstrecke).
 *
 * Vor der Korrektur hat die Kassa den Sig-Voriger-Beleg über den QR-Code des Vorbelegs gebildet statt über seine JWS-Compact-Form
 * (RKSV Anlage 1 Z 4). Eine Kasse, die vor dem Update Belege signiert hat, trägt diese „Altform" ab dem 2. Beleg; sie ist
 * Teil des signierten Codes und lässt sich nicht ändern. Der Selbsttest erkennt sie aus den Daten und weist sie aus, statt
 * die Kette als unterbrochen zu melden — einen echten Bruch meldet er weiter.
 *
 * Die Altkette wird WIRKLICH nachgebaut: Beleg für Beleg mit dem Verkettungswert der Altform und neu mit dem echten
 * Schlüssel der Kasse signiert (so entstünde sie in einer alten Kasse). Danach signiert die Kassa weitere Belege regulär —
 * wie nach dem Update.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { jwsSigningInput, signiereRoh, verkettungswertFolgebeleg, type FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, kassen } from '../../src/db/schema.js'
import { decryptPrivateKey } from '../../src/crypto/master-key.js'

const ADMIN_EMAIL    = 'admin@altkette.at'
const ADMIN_PASSWORT = 'altkette-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'AK-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

/** Die Verkettung der Altform: erste 8 Byte SHA-256 des QR-Codes des Vorbelegs, Base64 */
const altform = (vorbelegQr: string): string =>
  createHash('sha256').update(vorbelegQr, 'utf8').digest().subarray(0, 8).toString('base64')

describe('Signatur-Selbsttest: bestehende Ketten (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let privateKeyDER: Buffer

  const auth = () => ({ authorization: `Bearer ${token}` })
  const selbsttest = async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/rksv/signatur-selbsttest?kasseId=${kasseId}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const csv = async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/rksv/signatur-selbsttest.csv?kasseId=${kasseId}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    return res.body
  }
  const barzahlen = async (cent: number) => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Bier', preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
        zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode, res.body).toBe(201)
  }
  const alleBelege = () =>
    idb.db.select().from(belege).where(eq(belege.kasseId, kasseId)).orderBy(asc(belege.belegNummer))

  /** Beleg `row` in der Altform verketten und neu signieren; liefert seinen neuen QR-Code (für den Nachfolger). */
  async function alsAltform(row: typeof belege.$inferSelect, vorbelegQr: string): Promise<string> {
    const sigVorbeleg = altform(vorbelegQr)
    const ohneSig     = row.maschinenlesbareCode.slice(0, row.maschinenlesbareCode.lastIndexOf('_'))
    const codeOhneSig = `${ohneSig.slice(0, ohneSig.lastIndexOf('_') + 1)}${sigVorbeleg}`        // letztes Feld = Sig-Voriger-Beleg
    const signatur    = signiereRoh(jwsSigningInput(codeOhneSig), { privateKeyDER }).toString('base64')
    const neuerCode   = `${codeOhneSig}_${signatur}`
    await idb.db.update(belege).set({ sigVorbeleg, signaturwert: signatur, maschinenlesbareCode: neuerCode }).where(eq(belege.id, row.id))
    return neuerCode
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Altkette GmbH', uid: 'ATU99999907', kassenId: 'AK-001',
        finanzOnline: { teilnehmerId: 'TID-AK', benutzerkennung: 'BID-AK', pin: 'PIN-AK' },
        umgebung: 'test', admin: { name: 'AK Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    privateKeyDER = Buffer.from(decryptPrivateKey(kasse!.seePrivateKeyEnc, TEST_MASTER) as unknown as Buffer)

    // Die Kasse hat vor dem Update sechs Belege nach dem Startbeleg signiert (Belege 2…7) …
    for (const cent of [1000, 2000, 3000, 4000, 5000, 6000]) await barzahlen(cent)
    expect((await selbsttest()).geprueft).toBe(7)
    expect((await selbsttest()).ketteAltformat).toBe(0)

    // … und zwar nach der alten Lesart: Belege 2…7 werden nachgebaut, jeder über den (neu gebauten) QR-Code seines Vorgängers.
    const rows = await alleBelege()
    let vorbelegQr = rows[0]!.maschinenlesbareCode
    for (const row of rows.slice(1)) vorbelegQr = await alsAltform(row, vorbelegQr)
    await idb.db.update(kassen).set({ letzterBelegCode: vorbelegQr }).where(eq(kassen.id, kasseId))

    // Nach dem Update signiert die Kassa regulär weiter (Belege 8…10).
    for (const cent of [7000, 8000, 9000]) await barzahlen(cent)
  }, 120_000)

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Bestandskasse nach dem Update: die Altstrecke (Belege 2…7) wird ausgewiesen, die Kette gilt als geschlossen', async () => {
    const e = await selbsttest()
    expect(e.geprueft).toBe(10)
    expect(e.ketteOk).toBe(true)
    expect(e.ketteAltformat).toBe(6)
    expect(e.ketteAltformatVon).toBe(2)
    expect(e.ketteAltformatBis).toBe(7)
    expect(e.ketteGemischt).toBe(false)
    expect(e.ketteBruchBeleg).toBeNull()
    // an den Signaturen ändert die Altform nichts: alle Belege sind gültig und lückenlos
    expect(e.gueltig).toBe(10)
    expect(e.ungueltig).toBe(0)
    expect(e.nummernLueckenlos).toBe(true)
    expect(e.details).toHaveLength(0)
  })

  it('der erste Beleg nach dem Update (8) ist nach Spezifikation verkettet, obwohl sein Vorgänger (7) noch die Altform trägt', async () => {
    const rows = await alleBelege()
    expect(rows[7]!.sigVorbeleg).toBe(verkettungswertFolgebeleg(rows[6]!.maschinenlesbareCode))     // Beleg 8 über die JWS-Form von Beleg 7
    expect(rows[6]!.sigVorbeleg).toBe(altform(rows[5]!.maschinenlesbareCode))                         // Beleg 7 noch über den QR-Code von Beleg 6
  })

  it('CSV-Protokoll dokumentiert die Altstrecke als Zusammenfassung unter der Tabelle', async () => {
    const text = await csv()
    expect(text).toContain('Signaturkette;geschlossen')
    expect(text).toContain('Verkettung im Altformat')
    expect(text).toContain('Belege 2–7 (6 Belege)')
    expect(text).not.toContain('UNTERBROCHEN')
  })

  it('Altformat NACH dem Umstieg (ältere Programmversion eingespielt): kein Bruch, aber „gemischt"', async () => {
    const rows = await alleBelege()
    await alsAltform(rows[9]!, rows[8]!.maschinenlesbareCode)               // der letzte Beleg (10) wieder in der Altform
    const e = await selbsttest()
    expect(e.ketteOk).toBe(true)
    expect(e.ketteAltformat).toBe(7)
    expect(e.ketteAltformatVon).toBe(2)
    expect(e.ketteAltformatBis).toBe(10)
    expect(e.ketteGemischt).toBe(true)
    expect((await csv())).toContain('Hinweis;Altformat auch NACH dem Umstieg')
  })

  it('ein gelöschter Beleg in der Altstrecke bleibt ein Kettenbruch (und lässt Lücken in den Belegnummern)', async () => {
    await idb.db.delete(belege).where(and(eq(belege.kasseId, kasseId), eq(belege.belegNummer, 4)))
    const e = await selbsttest()
    expect(e.ketteOk).toBe(false)
    expect(e.ketteBruchBeleg).toBe(5)
    expect(e.nummernLueckenlos).toBe(false)
    expect(await csv()).toContain('Signaturkette;UNTERBROCHEN bei Beleg 5')
  })
})
