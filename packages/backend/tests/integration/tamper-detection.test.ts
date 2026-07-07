/**
 * Integrationstest: Tamper-Detection auf den persistierten Belegen.
 *
 * Beweist, dass eine nachträgliche Manipulation eines Belegs DIREKT in der
 * Datenbank (z. B. ein gesenkter Betrag, um Umsatz zu verschleiern) durch die
 * ECDSA-Signaturprüfung erkannt wird. Genau diese Frage stellt eine
 * Finanzprüfung: „Stimmen die gespeicherten Daten noch mit der Signatur?"
 *
 * `pruefeKette` allein genügt dafür NICHT — eine geänderte Betragsspalte lässt
 * die Verkettung der Signaturwerte intakt. Erst `verifiziereBelegSignatur`
 * rekonstruiert den signierten Code aus den Feldern und deckt die Änderung auf.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { verifiziereBelegSignatur, type VerifizierbarerBeleg, type FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { belege, kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@tamper.at'
const ADMIN_PASSWORT = 'tamper-passwort-12345'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'TD-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Tamper GmbH',
  uid:        'ATU99999903',
  kassenId:   'TD-001',
  finanzOnline: { teilnehmerId: 'TID-TD', benutzerkennung: 'BID-TD', pin: 'PIN-TD' },
  umgebung: 'test',
  admin: { name: 'TD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

/** DB-Beleg-Zeile + Kassen-KID → die von der rksv-Verifikation erwartete Form. */
function alsVerifizierbar(row: typeof belege.$inferSelect, kassenId: string): VerifizierbarerBeleg {
  return {
    zdaId: 'AT0',
    kassenId,
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

describe('Tamper-Detection (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let kassenKID: string
  let zertifikatDER: Buffer

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)

    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Zwei Barzahlungen erzeugen (verschiedene Steuersätze)
    for (const pos of [
      { bezeichnung: 'Bier',  preisBruttoCent: 590,  mwstSatz: 'normal',      menge: 1 },
      { bezeichnung: 'Kaffee', preisBruttoCent: 350, mwstSatz: 'ermaessigt1', menge: 1 },
    ]) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/belege/barzahlung',
        headers: auth(),
        payload: { kasseId, positionen: [pos], zahlung: { barCent: pos.preisBruttoCent, karteCent: 0, sonstigeCent: 0 } },
      })
      expect(res.statusCode).toBe(201)
    }

    // Kassen-KID + öffentliches Zertifikat aus der DB laden (wie ein Prüfer)
    const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    kassenKID     = kasse!.kassenId
    zertifikatDER = Buffer.from(kasse!.seeZertifikatDer, 'base64')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('alle unveränderten Belege verifizieren gegen das Zertifikat', async () => {
    const rows = await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId))
    expect(rows.length).toBe(3) // Startbeleg + 2 Barzahlungen
    for (const row of rows) {
      expect(verifiziereBelegSignatur(alsVerifizierbar(row, kassenKID), zertifikatDER)).toBe(true)
    }
  })

  it('ein direkt in der DB gesenkter Betrag wird erkannt', async () => {
    // Angreifer-Szenario: Umsatz verschleiern, Bier 5,90 -> 1,00 € direkt im UPDATE
    const liste = await srv.fastify.inject({
      method: 'GET', url: `/api/belege?kasseId=${kasseId}&limit=500`, headers: auth(),
    })
    const bier = (liste.json() as BelegResponse[]).find(b => b.gesamtbetragCent === 590)!
    expect(bier).toBeDefined()

    await idb.db.update(belege).set({ betragNormalCent: 100 }).where(eq(belege.id, bier.id))

    const [manipuliert] = await idb.db.select().from(belege).where(eq(belege.id, bier.id))
    expect(verifiziereBelegSignatur(alsVerifizierbar(manipuliert!, kassenKID), zertifikatDER)).toBe(false)
  })

  it('die übrigen Belege bleiben nach der Manipulation valide (Schaden ist lokal)', async () => {
    const rows = await idb.db.select().from(belege).where(eq(belege.kasseId, kasseId))
    const valide   = rows.filter(r => verifiziereBelegSignatur(alsVerifizierbar(r, kassenKID), zertifikatDER))
    const ungueltig = rows.filter(r => !verifiziereBelegSignatur(alsVerifizierbar(r, kassenKID), zertifikatDER))
    expect(ungueltig).toHaveLength(1)
    expect(valide).toHaveLength(2)
  })
})
