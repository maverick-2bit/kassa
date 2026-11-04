/**
 * Integrationstest: Portal-Melder — die Box meldet ihren TECHNISCHEN Zustand an das Serviceportal.
 *
 * Ein echter HTTP-Server spielt das Portal. Geprüft wird, was tatsächlich über die Leitung geht:
 *   - nur Felder aus dem Schema (keine Umsätze, Belege, Kunden-/Mitarbeiterdaten, keine Drucker-Adressen)
 *   - Token im Header, Meldung gültig gegen das gemeinsame Schema
 *   - Fehlerberichte bereinigt; bei Fehlschlag nichts verloren, mit der nächsten Meldung nachgeliefert
 *   - ohne PORTAL_URL/PORTAL_TOKEN: keine Anfrage
 *   - GET /api/system/portal zeigt Stand, nie das Token
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { PortalMeldungSchema, type PortalMeldung } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { baueMeldung, holePortalStatus, sendeMeldung, _setzePortalZustandZurueck } from '../../src/services/portal-melder.service.js'
import { _leereFehlerSammler, meldeFehler } from '../../src/services/fehler-sammler.js'
import type { Config } from '../../src/config.js'

const ADMIN_EMAIL    = 'admin@portal.at'
const ADMIN_PASSWORT = 'portal-passwort-123'
const TOKEN          = 'box-token-0123456789abcdef-xyz'

function fo(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'PM-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

interface Empfangen { methode: string; url: string; auth: string | undefined; body: unknown }

describe('Portal-Melder (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let portal: http.Server
  let portalUrl = ''
  let empfangen: Empfangen[] = []
  let antwortStatus = 200
  let config: Config

  beforeAll(async () => {
    portal = http.createServer((req, res) => {
      let roh = ''
      req.on('data', c => { roh += c })
      req.on('end', () => {
        empfangen.push({ methode: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], body: roh ? JSON.parse(roh) : null })
        res.statusCode = antwortStatus
        res.end('{}')
      })
    })
    await new Promise<void>(r => portal.listen(0, '127.0.0.1', () => r()))
    portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`

    idb = await erstelleIntegrationsDb()
    config = { PORTAL_URL: portalUrl, PORTAL_TOKEN: TOKEN, PORTAL_INTERVALL_SEKUNDEN: 60 } as unknown as Config
    srv = await buildTestServer(idb.db, { finanzOnlineClient: fo(), config: { PORTAL_URL: portalUrl, PORTAL_TOKEN: TOKEN, PORTAL_INTERVALL_SEKUNDEN: 60 } })

    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Portal Wirtshaus GmbH', uid: 'ATU66666601', kassenId: 'PM-001',
        finanzOnline: { teilnehmerId: 'TID-PM', benutzerkennung: 'BID-PM', pin: 'PIN-PM' },
        umgebung: 'test',
        admin: { name: 'Portal Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setup.body}`)
  })

  afterAll(async () => {
    await new Promise<void>(r => portal.close(() => r()))
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => {
    empfangen = []
    antwortStatus = 200
    _setzePortalZustandZurueck()
    _leereFehlerSammler()
  })

  it('die Meldung enthält Betrieb, Kasse, Version, Sicherungen und Speicher — gültig gegen das gemeinsame Schema', async () => {
    const m = await baueMeldung(idb.db, config)
    expect(PortalMeldungSchema.safeParse(m).success).toBe(true)
    expect(m.schema).toBe(1)
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(m.db.ok).toBe(true)
    expect(m.betriebe).toHaveLength(1)
    expect(m.betriebe[0]).toMatchObject({ firmenname: 'Portal Wirtshaus GmbH', status: 'aktiv' })
    expect(m.betriebe[0]!.kassen).toHaveLength(1)
    expect(m.betriebe[0]!.kassen[0]).toMatchObject({ kassenId: 'PM-001', status: 'aktiv', seeAusgefallenSeit: null, offeneBonProbleme: 0 })
    expect(m.betriebe[0]!.kassen[0]!.seeGueltigBis).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(['ok', 'veraltet', 'fehlt']).toContain(m.backups.dbBackup.zustand)
    expect(['ok', 'knapp', 'kritisch', 'unbekannt']).toContain(m.speicher.zustand)
  })

  it('Datenschutz: genau die Felder aus dem Schema — keine Umsätze, Belege, Personen- oder Geräte-Adressen', async () => {
    const m = await baueMeldung(idb.db, config)
    const schluessel = new Set<string>()
    const sammle = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(sammle)
      else if (v && typeof v === 'object') for (const [k, w] of Object.entries(v)) { schluessel.add(k); sammle(w) }
    }
    sammle(m)
    // Ausdrückliche Liste: ein neues Feld in der Meldung lässt diesen Test rot werden und zwingt zur Prüfung
    expect([...schluessel].sort()).toEqual([
      'alterStunden', 'backups', 'betriebe', 'bezeichnung', 'db', 'depBackup', 'dbBackup', 'firmenname', 'fehler',
      'freiGb', 'freiProzent', 'gesamtGb', 'gesendetAm', 'id', 'kassen', 'kassenId', 'latenzMs', 'letzteSicherung',
      'offeneBonProbleme', 'ok', 'schema', 'seeAusgefallenSeit', 'seeGueltigBis', 'seeTyp', 'speicher', 'status',
      'umgebung', 'uptimeSek', 'version', 'zustand', 'drucker',
    ].sort())
    expect(JSON.stringify(m)).not.toContain(TOKEN)
  })
  it('sendet per POST mit Token im Header; Erfolg wird vermerkt', async () => {
    const ok = await sendeMeldung(idb.db, config)
    expect(ok).toBe(true)
    expect(empfangen).toHaveLength(1)
    expect(empfangen[0]).toMatchObject({ methode: 'POST', url: '/api/box/meldung', auth: `Bearer ${TOKEN}` })
    expect(PortalMeldungSchema.safeParse(empfangen[0]!.body).success).toBe(true)

    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const status = await srv.fastify.inject({
      method: 'GET', url: '/api/system/portal', headers: { authorization: `Bearer ${res.json().token}` },
    })
    expect(status.statusCode, status.body).toBe(200)
    expect(status.json()).toMatchObject({ aktiv: true, host: new URL(portalUrl).host, intervallSekunden: 60, fehlerInFolge: 0, letzterFehler: null })
    expect(status.json().letzterErfolg).toBeTruthy()
    expect(status.body).not.toContain(TOKEN)
  })

  it('Fehlerberichte gehen bereinigt mit; bei Fehlschlag nichts verloren, die nächste Meldung liefert sie nach', async () => {
    meldeFehler(new Error('Failed query: select * from kunden where email = $1 params: geheim@kunde.at'), { route: '/api/kunden/123e4567-e89b-12d3-a456-426614174000' })
    meldeFehler(new Error('Drucker kaputt'), { route: '/api/druck' })

    antwortStatus = 503
    expect(await sendeMeldung(idb.db, config)).toBe(false)
    expect(empfangen).toHaveLength(1)

    expect(holePortalStatus(config)).toMatchObject({ fehlerInFolge: 1 })
    expect(holePortalStatus(config).letzterFehler).toContain('503')

    // Portal wieder da → dieselben Fehler kommen jetzt an, genau einmal
    antwortStatus = 200
    meldeFehler(new Error('Drucker kaputt'), { route: '/api/druck' })   // währenddessen noch einmal aufgetreten
    expect(await sendeMeldung(idb.db, config)).toBe(true)
    const gesendet = (empfangen[1]!.body as PortalMeldung).fehler
    expect(gesendet).toHaveLength(2)
    expect(gesendet.find(f => f.meldung === 'Datenbankabfrage fehlgeschlagen')?.route).toBe('/api/kunden/:id')
    expect(gesendet.find(f => f.meldung === 'Drucker kaputt')?.anzahl).toBe(2)
    expect(JSON.stringify(gesendet)).not.toMatch(/geheim@|select|123e4567/)

    // danach ist der Sammler leer
    expect(await sendeMeldung(idb.db, config)).toBe(true)
    expect((empfangen[2]!.body as PortalMeldung).fehler).toEqual([])
    expect(holePortalStatus(config).fehlerInFolge).toBe(0)
  })

  it('ein nicht erreichbares Portal wirft nicht — die Kassa läuft weiter', async () => {
    const tot = { ...config, PORTAL_URL: 'http://127.0.0.1:9' } as Config
    await expect(sendeMeldung(idb.db, tot)).resolves.toBe(false)
  })

  it('ohne Adresse oder Token passiert nichts', async () => {
    expect(await sendeMeldung(idb.db, { ...config, PORTAL_URL: undefined } as Config)).toBe(false)
    expect(await sendeMeldung(idb.db, { ...config, PORTAL_TOKEN: undefined } as Config)).toBe(false)
    expect(empfangen).toHaveLength(0)
  })

  it('GET /api/system/portal: nur der Betreiber; ohne Anmeldung 401', async () => {
    const ohne = await srv.fastify.inject({ method: 'GET', url: '/api/system/portal' })
    expect(ohne.statusCode).toBe(401)
  })
})
