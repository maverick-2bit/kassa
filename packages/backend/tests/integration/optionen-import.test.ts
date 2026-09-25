/**
 * Integrationstest: Optionen-Import (POST /api/modifikator-gruppen/import).
 *
 * Prüft Artikel-Zuordnung über Name + Warengruppe, Wiederverwendung
 * inhaltsgleicher Gruppen (auch beim zweiten Import), das Ergänzen statt
 * Ersetzen bestehender Zuordnungen und die Fehlerliste für nicht/mehrdeutig
 * gefundene Artikel.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { ModifikatorGruppe, OptionenImportEintrag } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@optionen-import.at'
const ADMIN_PASSWORT = 'optionen-import-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Optionen-Import GmbH',
  uid:        'ATU99999919',
  kassenId:   'OPT-001',
  finanzOnline: { teilnehmerId: 'TID-OPT', benutzerkennung: 'BID-OPT', pin: 'PIN-OPT' },
  umgebung: 'test',
  admin: { name: 'OPT Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

const spritzerExtras = (artikel: string): OptionenImportEintrag => ({
  artikel, warengruppe: 'Spritzer', gruppe: 'mit Eis / mit Zitrone', typ: 'optional', maxAuswahl: 1,
  optionen: [{ name: 'mit Eis', aufschlagCent: 0 }, { name: 'mit Zitrone', aufschlagCent: 0 }],
})

describe('Optionen-Import (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  const ids: Record<string, string> = {}

  const auth = () => ({ authorization: `Bearer ${token}` })
  const importiere = (eintraege: OptionenImportEintrag[]) => srv.fastify.inject({
    method: 'POST', url: '/api/modifikator-gruppen/import', headers: auth(), payload: { eintraege },
  })
  const gruppenVon = async (artikelId: string) => (await srv.fastify.inject({
    method: 'GET', url: `/api/artikel/${artikelId}/modifikator-gruppen`, headers: auth(),
  })).json() as ModifikatorGruppe[]

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    token = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json().token

    const kat = async (name: string) => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/kategorien', headers: auth(),
        payload: { name, farbe: 'grau', reihenfolge: 0, terminalSichtbar: false },
      })
      if (res.statusCode !== 201) throw new Error(`Kategorie (${res.statusCode}): ${res.body}`)
      return res.json().id as string
    }
    const spritzer = await kat('Spritzer')
    const kellner  = await kat('Kellner Wein')
    const anlegen = async (schluessel: string, bezeichnung: string, kategorieId: string) => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/artikel', headers: auth(),
        payload: { bezeichnung, preisBruttoCent: 400, mwstSatz: 'normal', kategorieId },
      })
      if (res.statusCode !== 201) throw new Error(`Artikel (${res.statusCode}): ${res.body}`)
      ids[schluessel] = res.json().id
    }
    await anlegen('weiss',       'weißer Spritzer',          spritzer)
    await anlegen('suess',       'süßer Spritzer',           spritzer)
    await anlegen('muskBar',     '0,75l Muskateller+ Soda',  spritzer)
    await anlegen('muskKellner', '0,75l Muskateller+ Soda',  kellner)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert den Import ohne Token (401)', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/modifikator-gruppen/import', payload: { eintraege: [] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('lehnt einen leeren Import ab (400)', async () => {
    expect((await importiere([])).statusCode).toBe(400)
  })

  it('legt inhaltsgleiche Gruppen nur einmal an und ordnet sie allen Artikeln zu', async () => {
    const res = await importiere([
      spritzerExtras('weißer Spritzer'),
      spritzerExtras('SÜßER SPRITZER'),   // Groß/klein egal
      {
        artikel: '0,75l Muskateller+ Soda', warengruppe: 'spritzer', gruppe: 'Ohne Soda',
        typ: 'optional', maxAuswahl: 1, optionen: [{ name: 'Ohne Soda', aufschlagCent: -200 }],
      },
    ])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ gruppenNeu: 2, gruppenWiederverwendet: 0, zuweisungenNeu: 3, fehler: [] })

    const weiss = await gruppenVon(ids.weiss!)
    const suess = await gruppenVon(ids.suess!)
    expect(weiss).toHaveLength(1)
    expect(weiss[0]!.id).toBe(suess[0]!.id)
    expect(weiss[0]!.maxAuswahl).toBe(1)
    expect(weiss[0]!.modifikatoren.map(m => m.name)).toEqual(['mit Eis', 'mit Zitrone'])

    // Warengruppe unterscheidet gleichnamige Artikel
    const bar = await gruppenVon(ids.muskBar!)
    expect(bar[0]!.modifikatoren[0]!.aufschlagCent).toBe(-200)
    expect(await gruppenVon(ids.muskKellner!)).toEqual([])
  })

  it('zweiter Import derselben Daten legt nichts doppelt an', async () => {
    const res = await importiere([spritzerExtras('weißer Spritzer'), spritzerExtras('süßer Spritzer')])
    expect(res.json()).toEqual({ gruppenNeu: 0, gruppenWiederverwendet: 1, zuweisungenNeu: 0, fehler: [] })
    const alle = (await srv.fastify.inject({
      method: 'GET', url: '/api/modifikator-gruppen', headers: auth(),
    })).json() as ModifikatorGruppe[]
    expect(alle).toHaveLength(2)
  })

  it('ergänzt bestehende Zuordnungen statt sie zu ersetzen', async () => {
    const res = await importiere([{
      artikel: 'weißer Spritzer', warengruppe: 'Spritzer', gruppe: 'Glas',
      typ: 'pflicht', maxAuswahl: 1,
      optionen: [{ name: '1/4', aufschlagCent: 0 }, { name: '1/2', aufschlagCent: 300 }],
    }])
    expect(res.json().gruppenNeu).toBe(1)
    const gruppen = await gruppenVon(ids.weiss!)
    // Liste kommt nach Gruppenname sortiert, nicht in Zuordnungsreihenfolge
    expect(gruppen.map(g => g.name).sort()).toEqual(['Glas', 'mit Eis / mit Zitrone'])
    expect(gruppen.find(g => g.name === 'Glas')!.typ).toBe('pflicht')
  })

  it('meldet nicht gefundene und mehrdeutige Artikel, der Rest wird trotzdem importiert', async () => {
    const res = await importiere([
      { ...spritzerExtras('Gibt es nicht'), warengruppe: '' },
      { ...spritzerExtras('0,75l Muskateller+ Soda'), warengruppe: '' },
      { ...spritzerExtras('weißer Spritzer'), warengruppe: 'Falsche Gruppe' },
      { ...spritzerExtras('0,75l Muskateller+ Soda'), warengruppe: 'Kellner Wein' },
    ])
    const body = res.json()
    expect(body.fehler.map((f: { index: number; fehler: string }) => [f.index, f.fehler])).toEqual([
      [0, 'Artikel nicht gefunden'],
      [1, 'Artikel 2× vorhanden — bitte Warengruppe angeben'],
      [2, 'Artikel in dieser Warengruppe nicht gefunden'],
    ])
    expect(body.zuweisungenNeu).toBe(1)
    expect((await gruppenVon(ids.muskKellner!)).map(g => g.name)).toEqual(['mit Eis / mit Zitrone'])
  })
})
