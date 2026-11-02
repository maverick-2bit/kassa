/**
 * Integrationstest: Der DEP7-Export der Kassa (echte API, echtes PostgreSQL, echte Signierlogik) wird von
 * EXTERNEN Prüfern geprüft:
 *
 *  - Python-Zweitprüfer (scripts/rksv/dep7_pruefer.py) — läuft, wenn Python 3 gefunden wird (CI: immer)
 *  - BMF-Prüftool (Java, scripts/rksv/bmf-pruefer.mjs) — nur wenn BMF_PRUEFTOOL_DIR gesetzt ist (Nacht-Workflow)
 *
 * Der Export besteht wie beim BMF aus dep-export.json und cryptographicMaterialContainer.json.
 *
 * BEFUND A (behoben): Die Verkettung der Folgebelege nahm vor der Korrektur die QR-Form des Vorbelegs; RKSV Anlage 1
 * Z 4 und die BMF-Referenzdaten verlangen die JWS-Compact-Form (siehe packages/rksv/tests/bmf-referenz.test.ts).
 * Der Test dazu läuft jetzt streng (Verkettung wird mitgeprüft).
 *
 * BEFUND D (offen): Software-SEE = ZDA AT0 = „geschlossenes Gesamtsystem"; das Seriennummernformat bleibt ausgenommen
 * (`--ignoriere zksn-format`), die strengen Tests dazu sind `it.fails` — sie werden rot („Expect test to fail"),
 * sobald der Fehler behoben ist; dann das `.fails` entfernen und `zksn-format` aus der Ausnahme streichen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen } from '../../src/db/schema.js'
import { decryptPrivateKey } from '../../src/crypto/master-key.js'
import {
  findePython, fuehreBmfPrueftoolAus, fuehreZweitpruefungAus, schreibePruefDateien, type PruefDateien,
} from '../helpers/externePruefer.js'

const ADMIN_EMAIL    = 'admin@externe-pruefer.at'
const ADMIN_PASSWORT = 'externe-pruefer-123'
const PYTHON = findePython()

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'EP-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

describe('DEP7-Export der Kassa durch externe Prüfer (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let ordner: string
  let dateien: PruefDateien
  let anzahlBelege = 0

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = (url: string, payload: unknown) => srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
  const verkauf = async (positionen: object[], bar: number) => {
    const res = await post('/api/belege/barzahlung', { kasseId, positionen, zahlung: { barCent: bar, karteCent: 0, sonstigeCent: 0 } })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as { id: string }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Externe Prüfer GmbH', uid: 'ATU99999906', kassenId: 'EXT-001',
        finanzOnline: { teilnehmerId: 'TID-EP', benutzerkennung: 'BID-EP', pin: 'PIN-EP' },
        umgebung: 'test', admin: { name: 'EP Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setup.statusCode}): ${setup.body}`)
    const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT } })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Verkehr wie im Betrieb: alle Steuersätze, krumme Cent, Storno, Nullbeleg, SEE-Ausfall mit Sammelbeleg
    const bier = { bezeichnung: 'Bier', preisBruttoCent: 395, mwstSatz: 'normal', menge: 1 }
    const kaffee = { bezeichnung: 'Kaffee', preisBruttoCent: 350, mwstSatz: 'ermaessigt1', menge: 2 }
    const zeitung = { bezeichnung: 'Zeitung', preisBruttoCent: 260, mwstSatz: 'ermaessigt2', menge: 1 }
    const pfand = { bezeichnung: 'Pfand', preisBruttoCent: 1, mwstSatz: 'null', menge: 3 }
    // Teilmengen (Gewicht) gibt es nur bei Artikeln aus dem Stamm
    const waage = await post('/api/artikel', { bezeichnung: 'Waage', preisBruttoCent: 333, mwstSatz: 'normal' })
    expect(waage.statusCode, waage.body).toBe(201)
    const krumm = { artikelId: waage.json().id, menge: 1.333 }
    const erster = await verkauf([bier], 395)
    await verkauf([kaffee, zeitung], 960)
    await verkauf([pfand], 3)
    await verkauf([krumm], 444)
    const st = await post('/api/belege/storno', { kasseId, verweisBelegId: erster.id })
    expect(st.statusCode, st.body).toBe(201)
    expect((await post('/api/belege/nullbeleg', { kasseId })).statusCode).toBe(201)
    expect((await post('/api/belege/see-ausfall', { kasseId })).statusCode).toBe(200)
    await verkauf([bier], 395)
    await verkauf([kaffee], 700)
    expect([200, 201]).toContain((await post('/api/belege/see-wiederherstellung', { kasseId })).statusCode)
    for (let i = 0; i < 8; i++) await verkauf([{ ...bier, preisBruttoCent: 100 + i * 37 }], 100 + i * 37)
    expect((await post('/api/belege/monatsbeleg', { kasseId })).statusCode).toBe(201)

    // Export wie ihn eine Finanzprüfung bekäme
    const dep7 = await srv.fastify.inject({ method: 'GET', url: `/api/belege/dep7?kasseId=${kasseId}`, headers: auth() })
    expect(dep7.statusCode).toBe(200)
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    const aes = Buffer.from(decryptPrivateKey(k!.aesSchluesselEnc!, TEST_MASTER) as unknown as Buffer)
    ordner  = mkdtempSync(join(tmpdir(), 'kassa-externe-pruefer-'))
    dateien = schreibePruefDateien(ordner, dep7.json(), aes, Buffer.from(k!.seeZertifikatDer, 'base64'))
    anzahlBelege = (dep7.json()['Belege-Gruppe'] as { 'Belege-kompakt': string[] }[]).reduce((s, g) => s + g['Belege-kompakt'].length, 0)
  }, 120_000)

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
    if (ordner) rmSync(ordner, { recursive: true, force: true })
  })

  it('der Export enthält alle Belege (Start, Umsätze, Storno, Null, Ausfall, Sammel, Monat)', () => {
    expect(anzahlBelege).toBeGreaterThanOrEqual(18)
  })

  describe.skipIf(!PYTHON)('Python-Zweitprüfer', () => {
    it('Signaturen (ES256), Verkettung, Umsatzzähler (AES), Format, Seriennummer, Belegnummern, Zeit: sauber — AT0-Seriennummernformat (D) ausgenommen', () => {
      const lauf = fuehreZweitpruefungAus(dateien, ['--ignoriere', 'zksn-format'])
      expect(lauf.bericht?.verstoesse, lauf.ausgabe).toEqual([])
      expect(lauf.bericht?.geprueft).toBe(anzahlBelege)
      expect(lauf.bericht!.ausfallbelege).toBeGreaterThanOrEqual(2)
      expect(lauf.bericht!.signaturenGeprueft + lauf.bericht!.ausfallbelege).toBe(anzahlBelege)
      expect(lauf.exit).toBe(0)
    })

    it('BEFUND A (behoben)  die Verkettung entspricht der Spezifikation (JWS-Compact des Vorbelegs)', () => {
      const lauf = fuehreZweitpruefungAus(dateien)
      expect(lauf.bericht?.verstoesseJeRegel['verkettung'] ?? 0).toBe(0)
    })

    it.fails('BEFUND D  AT0-Belege tragen den Ordnungsbegriff mit Schlüssel-ID statt der Zertifikats-Seriennummer (BMF-Prüftool: FORMAT_CLOSED_SYSTEM_SERIAL)', () => {
      const lauf = fuehreZweitpruefungAus(dateien)
      expect(lauf.bericht?.verstoesseJeRegel['zksn-format'] ?? 0).toBe(0)
    })
  })

  describe.skipIf(!process.env.BMF_PRUEFTOOL_DIR)('BMF-Prüftool (Java)', () => {
    // Die Kassa ist hier AT0 (Software-SEE): das Tool beanstandet jeden Beleg am Seriennummernformat des geschlossenen Systems
    // (Befund D). Die Verkettung (Befund A, behoben) erreicht es dort nie; als offenes System prüft sie bmf-prueftool.test.ts.
    it.fails('BEFUND D  das BMF-Prüftool bestätigt den Export (AT0: scheitert am Seriennummernformat des geschlossenen Systems)', () => {
      const bmf = fuehreBmfPrueftoolAus(dateien)
      expect(bmf.ausgefuehrt).toBe(true)
      expect(bmf.fehlgeschlagen.map(f => `${f.name}: ${f.meldung}`)).toEqual([])
      expect(bmf.ok).toBe(true)
    })
  })
})
