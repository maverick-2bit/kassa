/**
 * Tests für die Beleg-Routen (alle auth-protected).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { buildTestServer, TEST_MANDANT_ID, TEST_MASTER } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'
import { generateSEE } from '@kassa/rksv'
import { encryptPrivateKey } from '../src/crypto/master-key.js'

const MANDANT_ID = TEST_MANDANT_ID
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
  seeEnc = encryptPrivateKey(see.privateKeyDER, TEST_MASTER)
})

// ---------------------------------------------------------------------------
// Mock-DB
// ---------------------------------------------------------------------------

interface MockState {
  kasse?:        Record<string, unknown> | null
  artikel?:      Record<string, unknown>[]
  verweisBeleg?: Record<string, unknown> | null
  belegInsertSpy?: ReturnType<typeof vi.fn>
  kasseUpdateSpy?: ReturnType<typeof vi.fn>
}

function mockDb(state: MockState = {}): Db {
  const belegInsertSpy = state.belegInsertSpy ?? vi.fn()
  const kasseUpdateSpy = state.kasseUpdateSpy ?? vi.fn()

  // Innerhalb der TX
  // Zählt .limit()-Aufrufe innerhalb der TX:
  //   1. Aufruf: Verweisbeleg-Lookup   → verweisBeleg
  //   2. Aufruf: Double-Storno-Check   → bereitsStorniertBeleg (Standard: leer)
  let txLimitCallCount = 0
  const txMock = {
    select: () => ({
      from: () => ({
        where: () => ({
          for:   () => Promise.resolve(state.kasse ? [state.kasse] : []),
          limit: () => {
            txLimitCallCount++
            if (txLimitCallCount === 1) {
              return Promise.resolve(state.verweisBeleg ? [state.verweisBeleg] : [])
            }
            // 2. Aufruf = Double-Storno-Check → Standard leer (kein bereits-Storno)
            return Promise.resolve([])
          },
          then:  (resolve: (v: unknown) => void) =>
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

  // Außerhalb der TX: Mandant-Scope-Check (kasse) + listBelege
  const outerSelectChain = {
    from: () => ({
      where: () => ({
        // Scope-Check: SELECT kassen WHERE id AND mandantId LIMIT 1
        limit: () => Promise.resolve(state.kasse ? [state.kasse] : []),
        // listBelege: SELECT belege WHERE kasseId ORDER BY ... LIMIT N
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }

  return {
    transaction: async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    select:      () => outerSelectChain,
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
    letzteBelegNummer:   1,
    letzterSignaturwert: 'startbeleg-signaturwert-base64url',
    bei_fo_registriert:  true,
    fo_pruefwert:        'PW-TEST',
    registriert_am:      new Date('2026-05-20'),
    druckerIp:           null,
    druckerPort:         9100,
    druckerAktiv:        false,
    druckerBreite:       42,
    kdsStationen:        {},
    kdsPort:             9100,
    kdsAktiv:            false,
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
    station:         null,
    aktiv:           true,
    createdAt:       new Date(),
    updatedAt:       new Date(),
  }
}

// ---------------------------------------------------------------------------
// Auth-Schutz
// ---------------------------------------------------------------------------

describe('Auth-Schutz Beleg-Routen', () => {
  it('POST /api/belege/barzahlung ohne Token → 401', async () => {
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse() }))
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung',
      payload: { kasseId: KASSE_ID, positionen: [], zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 0 } },
    })
    expect(res.statusCode).toBe(401)
    await srv.close()
  })

  it('Mandant-Isolation: Kasse eines anderen Mandanten → 404', async () => {
    // kasse: null → Scope-Check schlägt fehl
    const srv = await buildTestServer(mockDb({ kasse: null }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/nullbeleg',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().fehler).toContain('Kasse')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/belege/barzahlung
// ---------------------------------------------------------------------------

describe('POST /api/belege/barzahlung', () => {
  it('erstellt einen signierten Beleg (HTTP 201)', async () => {
    const artikelId = '30000000-0000-0000-0000-000000000001'
    const belegInsertSpy = vi.fn()
    const kasseUpdateSpy = vi.fn()
    const srv = await buildTestServer(mockDb({
      kasse:    aktiveKasse(),
      artikel:  [artikelRow(artikelId, 350)],
      belegInsertSpy,
      kasseUpdateSpy,
    }))

    const res = await srv.fastify.inject({
      method:  'POST',
      url:     '/api/belege/barzahlung',
      headers: srv.authHeader(),
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId, menge: 2 }],
        zahlung:    { barCent: 700, karteCent: 0, sonstigeCent: 0 },
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.belegNummer).toBe(2)
    expect(body.belegTyp).toBe('Barzahlungsbeleg')
    expect(body.gesamtbetragCent).toBe(700)
    expect(body.maschinenlesbareCode).toMatch(/^_R1-AT_/)
    expect(belegInsertSpy).toHaveBeenCalledOnce()
    expect(kasseUpdateSpy).toHaveBeenCalledOnce()
    await srv.close()
  })

  it('lehnt nicht-übereinstimmende Zahlungssumme ab (HTTP 400)', async () => {
    const artikelId = '30000000-0000-0000-0000-000000000002'
    const srv = await buildTestServer(mockDb({
      kasse:   aktiveKasse(),
      artikel: [artikelRow(artikelId, 350)],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/barzahlung',
      headers: srv.authHeader(),
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId, menge: 2 }],
        zahlung:    { barCent: 500, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toContain('Zahlung')
    await srv.close()
  })

  it('lehnt unbekannten Artikel ab (HTTP 404)', async () => {
    const srv = await buildTestServer(mockDb({
      kasse:   aktiveKasse(),
      artikel: [],
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/barzahlung',
      headers: srv.authHeader(),
      payload: {
        kasseId:    KASSE_ID,
        positionen: [{ artikelId: '30000000-0000-0000-0000-000000000999', menge: 1 }],
        zahlung:    { barCent: 100, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('Body-Validierung: positionen leer → 400', async () => {
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse() }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/barzahlung',
      headers: srv.authHeader(),
      payload: {
        kasseId:    KASSE_ID,
        positionen: [],
        zahlung:    { barCent: 0, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// POST /api/belege/storno
// ---------------------------------------------------------------------------

function vergangenerBarzahlungsbeleg() {
  return {
    id:                          '40000000-0000-0000-0000-000000000010',
    mandantId:                   MANDANT_ID,
    kasseId:                     KASSE_ID,
    belegNummer:                 2,
    belegDatum:                  new Date('2026-05-20T10:30:00Z'),
    belegTyp:                    'Barzahlungsbeleg',
    betragNormalCent:            0,
    betragErmaessigt1Cent:       700,
    betragErmaessigt2Cent:       0,
    betragNullCent:              0,
    betragBesondersCent:         0,
    summeBarCent:                700,
    summeKarteCent:              0,
    summeSonstigeCent:           0,
    umsatzzaehlerVerschluesselt: 'enc',
    zertifikatSn:                '12345',
    sigVorbeleg:                 'svw',
    signaturwert:                'sigw',
    maschinenlesbareCode:        '_R1-AT_...',
    positionen: [
      { bezeichnung: 'Espresso', menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' },
    ],
    createdAt: new Date(),
  }
}

describe('POST /api/belege/storno', () => {
  it('erstellt einen Stornobeleg mit negierten Beträgen', async () => {
    const srv = await buildTestServer(mockDb({
      kasse:        aktiveKasse(),
      verweisBeleg: vergangenerBarzahlungsbeleg(),
    }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/storno',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, verweisBelegId: '40000000-0000-0000-0000-000000000010' },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.belegTyp).toBe('Stornobeleg')
    expect(body.summeBarCent).toBe(-700)
    expect(body.gesamtbetragCent).toBe(-700)
    expect(body.positionen[0].bezeichnung).toMatch(/^Storno:/)
    expect(body.positionen[0].einzelpreisBreutto).toBe(-350)
    await srv.close()
  })

  it('404 wenn Vorgängerbeleg nicht existiert', async () => {
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse(), verweisBeleg: null }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/storno',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, verweisBelegId: '40000000-0000-0000-0000-000000000099' },
    })
    expect(res.statusCode).toBe(404)
    await srv.close()
  })

  it('400 wenn ein Stornobeleg storniert werden soll', async () => {
    const stornoBeleg = { ...vergangenerBarzahlungsbeleg(), belegTyp: 'Stornobeleg' }
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse(), verweisBeleg: stornoBeleg }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/storno',
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID, verweisBelegId: stornoBeleg.id },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().fehler).toContain('Stornobeleg')
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// Spezialbelege
// ---------------------------------------------------------------------------

describe('Spezialbelege (Nullbeleg, Monatsbeleg, Jahresbeleg)', () => {
  it.each([
    ['/api/belege/nullbeleg',   'Nullbeleg'],
    ['/api/belege/monatsbeleg', 'Monatsbeleg'],
    ['/api/belege/jahresbeleg', 'Jahresbeleg'],
  ])('%s erstellt einen %s ohne Umsatz', async (url, erwarteterTyp) => {
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse() }))
    const res = await srv.fastify.inject({
      method:  'POST', url,
      headers: srv.authHeader(),
      payload: { kasseId: KASSE_ID },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.belegTyp).toBe(erwarteterTyp)
    expect(body.gesamtbetragCent).toBe(0)
    expect(body.positionen).toEqual([])
    expect(body.maschinenlesbareCode).toMatch(/^_R1-AT_/)
    await srv.close()
  })

  it('lehnt fehlende kasseId ab', async () => {
    const srv = await buildTestServer(mockDb({ kasse: aktiveKasse() }))
    const res = await srv.fastify.inject({
      method:  'POST', url: '/api/belege/nullbeleg',
      headers: srv.authHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await srv.close()
  })
})
