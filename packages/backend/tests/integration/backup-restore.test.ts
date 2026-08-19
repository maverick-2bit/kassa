/**
 * Restore-Drill: Ein Backup, aus dem nie wiederhergestellt wurde, ist nur eine
 * Hoffnung. Dieser Test spielt den Ernstfall komplett durch:
 *
 *   Kasse einrichten → Belege signieren → pg_dump → frische Datenbank →
 *   psql-Restore → RKSV-Kette + jede einzelne Signatur verifizieren →
 *   Backend GEGEN DIE RESTORE-DB hochfahren und nahtlos WEITERBUCHEN
 *   (Verkettung über den Restore hinweg lückenlos).
 *
 * Voraussetzung: pg_dump/psql ≥ Server-Major (17). Fehlt der Client oder ist
 * er zu alt (Standard-Runner ohne PGDG), überspringt sich die Suite mit
 * deutlicher Meldung — der CI-Job installiert den 17er-Client best-effort.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { pruefeKette, verifiziereBelegSignatur, type FinanzOnlineClient, type VerifizierbarerBeleg } from '@kassa/rksv'
import { schema, type Db } from '../../src/db/client.js'
import { belege, kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { dropDatenbankSicher, erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const BASIS_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'

const ADMIN_EMAIL    = 'admin@restore-drill.at'
const ADMIN_PASSWORT = 'restore-drill-passwort-12'

function pgClientMajor(cmd: 'pg_dump' | 'psql'): number {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: false })
  if (r.error || r.status !== 0) return 0
  return parseInt(/(\d+)/.exec(r.stdout ?? '')?.[1] ?? '0', 10)
}

const CLIENT_OK = pgClientMajor('pg_dump') >= 17 && pgClientMajor('psql') >= 17
if (!CLIENT_OK) {
  console.warn('[restore-drill] übersprungen: pg_dump/psql ≥ 17 nicht verfügbar')
}

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RD-PW' }),
  } as unknown as FinanzOnlineClient
}

function alsVerifizierbar(row: typeof belege.$inferSelect, kassenKID: string): VerifizierbarerBeleg {
  return {
    zdaId:        'AT0',
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

describe.skipIf(!CLIENT_OK)('Backup-Restore-Drill (pg_dump → frische DB → weiterbuchen)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string

  let dumpDir: string
  let restoreName: string
  let restoreUrl: string
  let restoreSql: ReturnType<typeof postgres> | null = null
  let restoreDb: Db
  let restoreSrv: TestServer | null = null

  const barzahlen = (server: TestServer, tkn: string, kid: string, cent: number) =>
    server.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung',
      headers: { authorization: `Bearer ${tkn}` },
      payload: {
        kasseId: kid,
        positionen: [{ bezeichnung: 'Drill-Kaffee', preisBruttoCent: cent, mwstSatz: 'ermaessigt1', menge: 1 }],
        zahlung: { barCent: cent, karteCent: 0, sonstigeCent: 0 },
      },
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'RestoreDrill GmbH',
        uid:        'ATU99999908',
        kassenId:   'RD-001',
        finanzOnline: { teilnehmerId: 'TID-RD', benutzerkennung: 'BID-RD', pin: 'PIN-RD' },
        umgebung: 'test',
        admin: { name: 'RD Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    for (const cent of [350, 420, 990]) {
      const res = await barzahlen(srv, token, kasseId, cent)
      if (res.statusCode !== 201) throw new Error(`Barzahlung fehlgeschlagen: ${res.body}`)
    }

    dumpDir     = mkdtempSync(join(tmpdir(), 'kassa-restore-'))
    restoreName = `kassa_restore_${randomBytes(6).toString('hex')}`
    const u = new URL(BASIS_URL)
    u.pathname = `/${restoreName}`
    restoreUrl = u.toString()
  })

  afterAll(async () => {
    await restoreSrv?.close()
    await srv?.close()
    await restoreSql?.end()
    // Retry-fester DROP — Autovacuum-Kollision, siehe dropDatenbankSicher
    await dropDatenbankSicher(restoreName)
    await idb?.zerstoeren()
    rmSync(dumpDir, { recursive: true, force: true })
  })

  it('pg_dump sichert, psql stellt in eine frische Datenbank wieder her', async () => {
    const dumpPfad = join(dumpDir, 'drill.sql')

    const dump = spawnSync('pg_dump', ['--no-password', '-f', dumpPfad, idb.url], { encoding: 'utf8' })
    expect(dump.status, `pg_dump: ${dump.stderr}`).toBe(0)

    const admin = postgres(BASIS_URL, { max: 1, fetch_types: false })
    try {
      await admin.unsafe(`CREATE DATABASE ${restoreName}`)
    } finally {
      await admin.end()
    }

    const restore = spawnSync('psql', ['--no-password', '-q', '-v', 'ON_ERROR_STOP=1', '-f', dumpPfad, restoreUrl], { encoding: 'utf8' })
    expect(restore.status, `psql-Restore: ${restore.stderr}`).toBe(0)

    restoreSql = postgres(restoreUrl, { max: 5, onnotice: () => {}, fetch_types: false })
    restoreDb  = drizzle(restoreSql, { schema }) as Db

    // Bestandsgleichheit: Startbeleg + 3 Barzahlungen
    const original = await idb.db.select().from(belege)
    const kopie    = await restoreDb.select().from(belege)
    expect(kopie.length).toBe(original.length)
    expect(kopie.length).toBe(4)
  })

  it('RKSV-Kette und jede einzelne Signatur sind nach dem Restore intakt', async () => {
    const [kasse] = await restoreDb.select().from(kassen).where(eq(kassen.id, kasseId))
    expect(kasse).toBeTruthy()
    const zertifikatDER = Buffer.from(kasse!.seeZertifikatDer, 'base64')

    const rows = (await restoreDb.select().from(belege).where(eq(belege.kasseId, kasseId)))
      .sort((a, b) => a.belegNummer - b.belegNummer)

    expect(pruefeKette('RD-001', rows.map(r => ({
      maschinenlesbareCode: r.maschinenlesbareCode,
      sigVorbeleg:          r.sigVorbeleg,
    })))).toBe(true)

    for (const row of rows) {
      expect(
        verifiziereBelegSignatur(alsVerifizierbar(row, kasse!.kassenId), zertifikatDER),
        `Signatur Beleg #${row.belegNummer}`,
      ).toBe(true)
    }
  })

  it('das Backend bucht gegen die Restore-DB nahtlos weiter (Kette lückenlos)', async () => {
    restoreSrv = await buildTestServer(restoreDb, { finanzOnlineClient: mockFoClient() })

    const login = (await restoreSrv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    expect(login.token).toBeTruthy()

    const res = await barzahlen(restoreSrv, login.token, kasseId, 1250)
    expect(res.statusCode).toBe(201)

    const rows = (await restoreDb.select().from(belege).where(eq(belege.kasseId, kasseId)))
      .sort((a, b) => a.belegNummer - b.belegNummer)
    expect(rows.length).toBe(5)

    // Belegnummern lückenlos UND Verkettung über den Restore hinweg geschlossen
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.belegNummer).toBe(rows[i - 1]!.belegNummer + 1)
    }
    expect(pruefeKette('RD-001', rows.map(r => ({
      maschinenlesbareCode: r.maschinenlesbareCode,
      sigVorbeleg:          r.sigVorbeleg,
    })))).toBe(true)
  })
})
