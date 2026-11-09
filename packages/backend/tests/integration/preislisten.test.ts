/**
 * Integrationstest (echtes PostgreSQL, Migration 0080): Preislisten — Sonderpreise je Kunde.
 * Anlegen/Umbenennen/Löschen, Preise setzen (Upsert), Zuweisung an Kunden, Abfrage für die Kasse,
 * Mandantentrennung und Berechtigung.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'preislisten-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Preislisten ${nr} GmbH`,
    uid:        `ATU9999997${nr}`,
    kassenId:   `PL-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-PL-${nr}`, benutzerkennung: `BID-PL-${nr}`, pin: `PIN-PL-${nr}` },
    umgebung: 'test',
    admin: { name: `PL Admin ${nr}`, email: `admin${nr}@preislisten.at`, passwort: PASSWORT },
  }
}

interface Liste { id: string; name: string; aktiv: boolean; anzahlPreise: number; anzahlKunden: number; preise?: { artikelId: string; artikelBezeichnung: string; preisBruttoCent: number; regulaerBruttoCent: number }[] }
interface Kunde { id: string; preislisteId: string | null }

describe('Preislisten (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = '', tokenKellner = ''
  let artikel1 = '', artikel2 = '', artikelB = '', kundeA = '', kundeA2 = '', kundeB = ''

  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: { authorization: string }, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })
  const neueListe = async (name: string, h = authA()) => {
    const r = await inject('POST', '/api/preislisten', h, { name })
    expect(r.statusCode, r.body).toBe(201)
    return r.json() as Liste
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    for (const nr of [1, 2] as const) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const l = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@preislisten.at`, passwort: PASSWORT } })
      if (l.statusCode !== 200) throw new Error(`Login ${nr} (${l.statusCode}): ${l.body}`)
      if (nr === 1) tokenA = l.json().token; else tokenB = l.json().token
    }
    const k = await inject('POST', '/api/users', authA(), { name: 'Kellner', email: 'kellner@preislisten.at', passwort: PASSWORT, rolle: 'kellner', berechtigungen: ['kasse'], kassenIds: [] })
    if (k.statusCode !== 201) throw new Error(`Kellner (${k.statusCode}): ${k.body}`)
    tokenKellner = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kellner@preislisten.at', passwort: PASSWORT } })).json().token

    const art = async (h: { authorization: string }, bez: string, preis: number) =>
      (await inject('POST', '/api/artikel', h, { bezeichnung: bez, preisBruttoCent: preis, mwstSatz: 'normal' })).json().id as string
    artikel1 = await art(authA(), 'Toner schwarz', 6000)
    artikel2 = await art(authA(), 'Kabel', 500)
    artikelB = await art(authB(), 'Fremd-Artikel', 100)
    const kunde = async (h: { authorization: string }, firma: string) =>
      (await inject('POST', '/api/kunden', h, { firma })).json().id as string
    kundeA = await kunde(authA(), 'Tersus GmbH')
    kundeA2 = await kunde(authA(), 'Anderer Kunde')
    kundeB = await kunde(authB(), 'Fremdkunde')
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('legt Listen an, liefert sie mit Zählern, Namen sind je Betrieb eindeutig', async () => {
    const l = await neueListe('Tersus')
    expect(l).toMatchObject({ name: 'Tersus', aktiv: true, anzahlPreise: 0, anzahlKunden: 0 })
    expect((await inject('POST', '/api/preislisten', authA(), { name: 'Tersus' })).statusCode).toBe(409)
    expect((await inject('POST', '/api/preislisten', authA(), { name: '   ' })).statusCode).toBe(400)
    // derselbe Name in einem anderen Betrieb ist erlaubt
    expect((await inject('POST', '/api/preislisten', authB(), { name: 'Tersus' })).statusCode).toBe(201)

    const liste = (await inject('GET', '/api/preislisten', authA())).json() as Liste[]
    expect(liste.map(x => x.name)).toContain('Tersus')
  })

  it('Preise setzen ist ein Upsert; Detail zeigt Sonderpreis und regulären Preis', async () => {
    const l = await neueListe('Upsert-Liste')
    const r1 = await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 5400 }, { artikelId: artikel2, preisBruttoCent: 450 }] })
    expect(r1.statusCode, r1.body).toBe(200)
    expect((r1.json() as Liste).preise).toEqual([
      { artikelId: artikel2, artikelBezeichnung: 'Kabel', preisBruttoCent: 450, regulaerBruttoCent: 500, artikelAktiv: true },
      { artikelId: artikel1, artikelBezeichnung: 'Toner schwarz', preisBruttoCent: 5400, regulaerBruttoCent: 6000, artikelAktiv: true },
    ])
    // zweiter Aufruf überschreibt (kein Duplikat); doppelter Artikel in einer Anfrage: der letzte Wert gilt
    const r2 = await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 1 }, { artikelId: artikel1, preisBruttoCent: 5000 }] })
    const d = r2.json() as Liste
    expect(d.anzahlPreise).toBe(2)
    expect(d.preise!.find(p => p.artikelId === artikel1)!.preisBruttoCent).toBe(5000)
  })

  it('Preise: leere Liste, negativer Preis, fremder Artikel → Fehler, nichts wird geschrieben', async () => {
    const l = await neueListe('Fehler-Liste')
    const put = (preise: unknown) => inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise })
    expect((await put([])).statusCode).toBe(400)
    expect((await put([{ artikelId: artikel1, preisBruttoCent: -1 }])).statusCode).toBe(400)
    expect((await put([{ artikelId: artikel1, preisBruttoCent: 100 }, { artikelId: artikelB, preisBruttoCent: 100 }])).statusCode).toBe(404)
    expect(((await inject('GET', `/api/preislisten/${l.id}`, authA())).json() as Liste).anzahlPreise).toBe(0)
  })

  it('einen Preis entfernen; unbekannter Preis → 404', async () => {
    const l = await neueListe('Entfernen')
    await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 100 }] })
    expect((await inject('DELETE', `/api/preislisten/${l.id}/preise/${artikel1}`, authA())).statusCode).toBe(204)
    expect((await inject('DELETE', `/api/preislisten/${l.id}/preise/${artikel1}`, authA())).statusCode).toBe(404)
  })

  it('Kunde: Zuweisung per Update, Kasse bekommt Liste samt Preisen; ohne Liste → null', async () => {
    const l = await neueListe('Für Tersus')
    await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 5400 }] })

    const put = await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: l.id })
    expect(put.statusCode, put.body).toBe(200)
    expect((put.json() as Kunde).preislisteId).toBe(l.id)

    const fuerKunde = await inject('GET', `/api/preislisten/fuer-kunde/${kundeA}`, authA())
    expect(fuerKunde.json()).toEqual({ preislisteId: l.id, name: 'Für Tersus', preise: [{ artikelId: artikel1, preisBruttoCent: 5400 }] })
    expect(await (await inject('GET', `/api/preislisten/fuer-kunde/${kundeA2}`, authA())).json()).toBeNull()

    // Zähler
    expect(((await inject('GET', `/api/preislisten/${l.id}`, authA())).json() as Liste)).toMatchObject({ anzahlPreise: 1, anzahlKunden: 1 })
    // Zuweisung lösen: Kunde zurück auf normale Preise
    const frei = await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: null })
    expect((frei.json() as Kunde).preislisteId).toBeNull()
    expect(await (await inject('GET', `/api/preislisten/fuer-kunde/${kundeA}`, authA())).json()).toBeNull()
  })

  it('Kunde: fremde oder deaktivierte Preisliste lässt sich nicht zuweisen; beim Anlegen geht es auch', async () => {
    const fremd = await neueListe('Nur Betrieb B', authB())
    expect((await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: fremd.id })).statusCode).toBe(404)
    expect((await inject('POST', '/api/kunden', authA(), { firma: 'Neu mit fremder Liste', preislisteId: fremd.id })).statusCode).toBe(404)

    const aus = await neueListe('Deaktiviert')
    await inject('PUT', `/api/preislisten/${aus.id}`, authA(), { aktiv: false })
    expect((await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: aus.id })).statusCode).toBe(409)

    const ok = await neueListe('Beim Anlegen')
    const neu = await inject('POST', '/api/kunden', authA(), { firma: 'Neukunde mit Liste', preislisteId: ok.id })
    expect(neu.statusCode, neu.body).toBe(201)
    expect((neu.json() as Kunde).preislisteId).toBe(ok.id)
  })

  it('eine später deaktivierte Liste wirkt an der Kasse nicht mehr; Reaktivieren bringt sie zurück', async () => {
    const l = await neueListe('Wird deaktiviert')
    await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel2, preisBruttoCent: 300 }] })
    await inject('PUT', `/api/kunden/${kundeA2}`, authA(), { preislisteId: l.id })
    expect((await (await inject('GET', `/api/preislisten/fuer-kunde/${kundeA2}`, authA())).json() as { name: string }).name).toBe('Wird deaktiviert')
    await inject('PUT', `/api/preislisten/${l.id}`, authA(), { aktiv: false })
    expect(await (await inject('GET', `/api/preislisten/fuer-kunde/${kundeA2}`, authA())).json()).toBeNull()
    await inject('PUT', `/api/preislisten/${l.id}`, authA(), { aktiv: true })
    expect(await (await inject('GET', `/api/preislisten/fuer-kunde/${kundeA2}`, authA())).json()).not.toBeNull()
  })

  it('Löschen einer Liste entfernt ihre Preise und gibt die Kunden frei', async () => {
    const l = await neueListe('Wird gelöscht')
    await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 100 }] })
    await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: l.id })
    expect((await inject('DELETE', `/api/preislisten/${l.id}`, authA())).statusCode).toBe(204)
    expect((await inject('GET', `/api/preislisten/${l.id}`, authA())).statusCode).toBe(404)
    const kunde = (await inject('GET', `/api/kunden/${kundeA}`, authA())).json() as Kunde
    expect(kunde.preislisteId).toBeNull()
    // der Artikel selbst ist unberührt
    expect((await inject('GET', '/api/artikel', authA())).json().some((a: { id: string }) => a.id === artikel1)).toBe(true)
  })

  it('Umbenennen: Kollision → 409', async () => {
    const a = await neueListe('Umbenennen A'); await neueListe('Umbenennen B')
    expect((await inject('PUT', `/api/preislisten/${a.id}`, authA(), { name: 'Umbenennen B' })).statusCode).toBe(409)
    const ok = await inject('PUT', `/api/preislisten/${a.id}`, authA(), { name: 'Umbenennen C' })
    expect(ok.json()).toMatchObject({ name: 'Umbenennen C' })
  })

  it('Mandantentrennung: Betrieb B sieht/ändert nichts von Betrieb A, auch nicht über die Kasse-Abfrage', async () => {
    const l = await neueListe('Nur A')
    await inject('PUT', `/api/preislisten/${l.id}/preise`, authA(), { preise: [{ artikelId: artikel1, preisBruttoCent: 100 }] })
    await inject('PUT', `/api/kunden/${kundeA}`, authA(), { preislisteId: l.id })
    expect(((await inject('GET', '/api/preislisten', authB())).json() as Liste[]).some(x => x.id === l.id)).toBe(false)
    for (const [m, u, b] of [
      ['GET', `/api/preislisten/${l.id}`, undefined], ['PUT', `/api/preislisten/${l.id}`, { name: 'x' }],
      ['DELETE', `/api/preislisten/${l.id}`, undefined], ['PUT', `/api/preislisten/${l.id}/preise`, { preise: [{ artikelId: artikelB, preisBruttoCent: 1 }] }],
      ['DELETE', `/api/preislisten/${l.id}/preise/${artikel1}`, undefined],
      ['GET', `/api/preislisten/fuer-kunde/${kundeA}`, undefined],
    ] as const) {
      expect((await inject(m, u, authB(), b)).statusCode, `${m} ${u}`).toBe(404)
    }
    expect((await inject('GET', `/api/preislisten/fuer-kunde/${kundeB}`, authA())).statusCode).toBe(404)
    expect(((await inject('GET', `/api/preislisten/${l.id}`, authA())).json() as Liste).anzahlPreise).toBe(1)
  })

  it('Berechtigung: Verwaltung nur mit „artikel.verwalten"; die Kasse-Abfrage dürfen alle Angemeldeten', async () => {
    const l = await neueListe('Berechtigung')
    const k = { authorization: `Bearer ${tokenKellner}` }
    expect((await inject('GET', '/api/preislisten', k)).statusCode).toBe(403)
    expect((await inject('POST', '/api/preislisten', k, { name: 'Nein' })).statusCode).toBe(403)
    expect((await inject('GET', `/api/preislisten/${l.id}`, k)).statusCode).toBe(403)
    expect((await inject('PUT', `/api/preislisten/${l.id}`, k, { name: 'Nein' })).statusCode).toBe(403)
    expect((await inject('DELETE', `/api/preislisten/${l.id}`, k)).statusCode).toBe(403)
    expect((await inject('PUT', `/api/preislisten/${l.id}/preise`, k, { preise: [{ artikelId: artikel1, preisBruttoCent: 1 }] })).statusCode).toBe(403)
    expect((await inject('GET', `/api/preislisten/fuer-kunde/${kundeA2}`, k)).statusCode).toBe(200)

    // Kundenverwaltung darf die Listen zur Auswahl lesen (Zuweisung am Kunden), aber nichts ändern
    const ku = await inject('POST', '/api/users', authA(), { name: 'Kundenpfleger', email: 'kunden@preislisten.at', passwort: PASSWORT, rolle: 'kellner', berechtigungen: ['kunden.verwalten'], kassenIds: [] })
    expect(ku.statusCode, ku.body).toBe(201)
    const kt = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kunden@preislisten.at', passwort: PASSWORT } })).json().token as string
    const kuAuth = { authorization: `Bearer ${kt}` }
    expect((await inject('GET', '/api/preislisten', kuAuth)).statusCode).toBe(200)
    expect((await inject('GET', `/api/preislisten/${l.id}`, kuAuth)).statusCode).toBe(403)
    expect((await inject('POST', '/api/preislisten', kuAuth, { name: 'Nein' })).statusCode).toBe(403)
    expect((await inject('GET', '/api/preislisten', { authorization: 'Bearer ungueltig' })).statusCode).toBe(401)
  })
})
