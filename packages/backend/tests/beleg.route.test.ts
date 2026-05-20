/**
 * Tests für die Beleg-Routen.
 * Erstellt einen echten Beleg gegen eine vollständig gemockte DB
 * (insbesondere transaction + for-update auf der Kassen-Row).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { buildServer } from '../src/server.js'
import type { Db } from '../src/db/client.js'
import { generateSEE } from '@kassa/rksv'
import { encryptPrivateKey } from '../src/crypto/master-key.js'

const MASTER = 'test-passphrase-long-enough'
const MANDANT_ID = '10000000-0000-0000-0000-000000000001'
const KASSE_ID   = '20000000-0000-0000-0000-000000000001'

let seeDer: Buffer
let seeEnc: string

beforeAll(async () => {
  const see = await generateSEE({
    kassenId:  'KASSE-TEST',
    uid:       'ATU12345678',
    firmenname: 'Test GmbH',
  })
  seeDer = see.zertifikatDER
  seeEnc = encryptPrivateKey(see.privateKeyDER, MASTER)
})

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

interface MockState {
  kasse?:    Record<string, unknown> | null
  artikel?:  Record<string, unknown>[]
  belegInsertSpy?: ReturnType<typeof vi.fn>
  kasseUpdateSpy?: ReturnType<typeof vi.fn>
}

function mockDb(state: MockState = {}): Db {
  const belegInsertSpy = state.belegInsertSpy ?? vi.fn()
  const kasseUpdateSpy = state.kasseUpdateSpy ?? vi.fn()

  // Wir differenzieren kasse vs. artikel über .for() (nur Kasse nutzt SELECT FOR UPDATE)
  const txMock = {
    select: () => ({
      from: () => ({
        where: () => ({
          // Kasse-Selection (mit SELECT FOR UPDATE)
          for: () => Promise.resolve(state.kasse ? [state.kasse] : []),
          // Artikel-Selection (ohne .for, direkt awaitable)
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve(state.artikel ?? []).then(resolve),
        }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        belegInsertSpy(v)
        return {
          returning: () => Promise.resolve([{ ...(v as object), id: 'beleg-uuid', createdAt: new Date() }]),
        }
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        kasseUpdateSpy(v)
        return { where: () => Promise.resolve() }
      },
    }),
  }

  return {
    transaction: async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    select:      () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function aktiveKasse() {
  return {
    id:                  KASSE_ID,
    mandantId:           MANDANT_ID,
    kassenId:            'KASSE-TEST',
    status:              'aktiv',
    umgebung:            'test',
    seeZertifikatDer:    seeDer.toString('base64'),
    seePrivateKeyEnc:    seeEnc,
    seeZertifikatSn:     '12345',
    seeGueltigBis:       new Date('2030-01-01'),
    umsatzzaehlerCent:   0n,
    letzteBelegNummer:   1, // Startbeleg #1 schon erstellt
    letzterSignaturwert: 'startbeleg-signaturwert-base64url',
    bei_fo_registriert:  true,
    fo_pruefwert:        'PW-TEST',
    registriert_am:      new Date('2026-05-20'),
    createdAt:           new Date(),
    updatedAt:           new Date(),
  }
}

function artikelRow(id: string, preis: number, mwst = 'ermaessigt1') {
  return {
    id,
    mandantId:       MANDANT_ID,
    bezeichnung:     `Artikel-${id.slice(0, 4)}`,
    preisBruttoCent: preis,
    mwstSatz:        mwst,
    artikelnummer:   null,
    aktiv:           true,
    createdAt:       new Date(),
    updatedAt:       new Date(),
  }
}

async function buildTestServer(db: Db) {
  return buildServer({
    config: {
      DATABASE_URL:      'postgresql://test',
      MASTER_PASSPHRASE: MASTER,
      PORT:              3000,
      LOG_LEVEL:         'fatal',
      CORS_ORIGIN:       '*',
      NODE_ENV:          'test',
    },
    db,
    setupDeps: { db, masterPassphrase: MASTER },
    belegDeps: { db, masterPassphrase: MASTER },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/belege/barzahlung', () => {
  it('erstellt einen signierten Beleg (HTTP 201)', async () => {
    const artikelId = '30000000-0000-0000-0000-000000000001'
    const belegInsertSpy = vi.fn()
    const kasseUpdateSpy = vi.fn()
    const db = mockDb({
      kasse:    aktiveKasse(),
      artikel:  [artikelRow(artikelId, 350)],
      belegInsertSpy,
      kasseUpdateSpy,
    })
    const server = await buildTestServer(db)

    const res = await server.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId, menge: 2 }],
        zahlung:    { barCent: 700, karteCent: 0, sonstigeCent: 0 },
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.belegNummer).toBe(2) // Startbeleg war 1, jetzt 2
    expect(body.belegTyp).toBe('Barzahlungsbeleg')
    expect(body.gesamtbetragCent).toBe(700)
    expect(body.maschinenlesbareCode).toMatch(/^_R1-AT_/)
    expect(belegInsertSpy).toHaveBeenCalledOnce()
    expect(kasseUpdateSpy).toHaveBeenCalledOnce()
    await server.close()
  })

  it('lehnt nicht-übereinstimmende Zahlungssumme ab (HTTP 400)', async () => {
    const artikelId = '30000000-0000-0000-0000-000000000002'
    const db = mockDb({
      kasse:   aktiveKasse(),
      artikel: [artikelRow(artikelId, 350)],
    })
    const server = await buildTestServer(db)

    const res = await server.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId, menge: 2 }], // total 700
        zahlung:    { barCent: 500, karteCent: 0, sonstigeCent: 0 }, // falsch
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toContain('Zahlung')
    await server.close()
  })

  it('lehnt unbekannten Artikel ab (HTTP 404)', async () => {
    const db = mockDb({
      kasse:   aktiveKasse(),
      artikel: [], // kein Artikel gefunden
    })
    const server = await buildTestServer(db)
    const res = await server.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId: '30000000-0000-0000-0000-000000000999', menge: 1 }],
        zahlung:    { barCent: 100, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(404)
    await server.close()
  })

  it('lehnt nicht-existente Kasse ab (HTTP 404)', async () => {
    const db = mockDb({ kasse: null })
    const server = await buildTestServer(db)
    const res = await server.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId: '30000000-0000-0000-0000-000000000001', menge: 1 }],
        zahlung:    { barCent: 100, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toContain('Kasse')
    await server.close()
  })

  it('Body-Validierung: positionen leer → 400', async () => {
    const db = mockDb({ kasse: aktiveKasse() })
    const server = await buildTestServer(db)
    const res = await server.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      payload: {
        kasseId:    KASSE_ID,
        positionen: [],
        zahlung:    { barCent: 0, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(400)
    await server.close()
  })
})
