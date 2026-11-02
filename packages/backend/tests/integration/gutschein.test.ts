/**
 * Integrationstest: Gutscheine gegen echtes PostgreSQL.
 *
 * Geld-kritisch. Prüft: Ausstellen (Saldo), Teil-/Voll-Einlösung, Restwert,
 * keine Über- oder Doppel-Einlösung, Restgutschein, Storno, Code-Lookup.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { GutscheinResponse, GutscheinEinloesungResult } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@gutschein.at'
const ADMIN_PASSWORT = 'gutschein-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gutschein GmbH',
  uid:        'ATU99999908',
  kassenId:   'GS-001',
  finanzOnline: { teilnehmerId: 'TID-GS', benutzerkennung: 'BID-GS', pin: 'PIN-GS' },
  umgebung: 'test',
  admin: { name: 'GS Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Gutscheine (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function erstelle(betragCent: number, code?: string, gueltigBis?: string): Promise<GutscheinResponse> {
    const r = await srv.fastify.inject({
      method: 'POST', url: '/api/gutscheine', headers: auth(),
      payload: { betragCent, ...(code && { code }), ...(gueltigBis && { gueltigBis }) },
    })
    if (r.statusCode !== 201) throw new Error(`Gutschein (${r.statusCode}): ${r.body}`)
    return r.json() as GutscheinResponse
  }

  const einloesen = (id: string, einloesungCent: number, erstelleRestgutschein = false, headers = auth()) =>
    srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${id}/einloesen`, headers,
      payload: { einloesungCent, erstelleRestgutschein },
    })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    token = loginRes.json().token
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('verweigert die Gutschein-Liste ohne Token (401)', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: '/api/gutscheine' })
    expect(res.statusCode).toBe(401)
  })

  it('stellt einen Gutschein mit vollem Restwert aus', async () => {
    const gs = await erstelle(5000)
    expect(gs.status).toBe('aktiv')
    expect(gs.betragCent).toBe(5000)
    expect(gs.bezahltCent).toBe(0)
    expect(gs.restCent).toBe(5000)
    expect(gs.code).toBeTruthy()
  })

  it('findet einen Gutschein über seinen Code', async () => {
    const gs = await erstelle(1000, 'TESTCODE-123')
    const res = await srv.fastify.inject({
      method: 'GET', url: '/api/gutscheine/code/TESTCODE-123', headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(gs.id)
  })

  it('löst teilweise ein, dann den Rest — Saldo und Status stimmen', async () => {
    const gs = await erstelle(5000)

    const teil = await einloesen(gs.id, 2000)
    expect(teil.statusCode).toBe(200)
    const nachTeil = (teil.json() as GutscheinEinloesungResult).gutschein
    expect(nachTeil.bezahltCent).toBe(2000)
    expect(nachTeil.restCent).toBe(3000)
    expect(nachTeil.status).toBe('teileingeloest')

    const rest = await einloesen(gs.id, 3000)
    expect(rest.statusCode).toBe(200)
    const nachVoll = (rest.json() as GutscheinEinloesungResult).gutschein
    expect(nachVoll.restCent).toBe(0)
    expect(nachVoll.status).toBe('eingeloest')

    // bereits vollständig eingelöst -> 400
    const nochmal = await einloesen(gs.id, 100)
    expect(nochmal.statusCode).toBe(400)
  })

  it('verweigert Einlösung über dem Restwert (400)', async () => {
    const gs = await erstelle(1000)
    const res = await einloesen(gs.id, 1500)
    expect(res.statusCode).toBe(400)
    // Gutschein bleibt unangetastet
    const unveraendert = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/${gs.id}`, headers: auth(),
    })
    expect((unveraendert.json() as GutscheinResponse).restCent).toBe(1000)
  })

  it('stellt bei Teil-Einlösung mit Restgutschein einen neuen Gutschein über den Rest aus', async () => {
    const gs = await erstelle(5000)
    const res = await einloesen(gs.id, 2000, true)
    expect(res.statusCode).toBe(200)
    const result = res.json() as GutscheinEinloesungResult

    // Original vollständig abgeschrieben
    expect(result.gutschein.status).toBe('eingeloest')
    // Neuer Restgutschein über 3000
    expect(result.restGutschein).toBeDefined()
    expect(result.restGutschein!.betragCent).toBe(3000)
    expect(result.restGutschein!.restCent).toBe(3000)
    expect(result.restGutschein!.status).toBe('aktiv')
    expect(result.restGutschein!.id).not.toBe(gs.id)
  })

  it('stornierter Gutschein kann nicht eingelöst werden', async () => {
    const gs = await erstelle(2000)
    const storno = await srv.fastify.inject({
      method: 'POST', url: `/api/gutscheine/${gs.id}/stornieren`, headers: auth(),
    })
    expect(storno.statusCode).toBe(200)
    expect((storno.json() as GutscheinResponse).status).toBe('storniert')

    const res = await einloesen(gs.id, 500)
    expect(res.statusCode).toBe(400)
  })

  /**
   * `gueltigBis` ist ein Kalendertag (YYYY-MM-DD) und zählt nach dem Wiener Datum.
   * Von 00:00 bis 02:00 Uhr Wiener Sommerzeit (Winterzeit: bis 01:00) steht das
   * UTC-Datum noch auf dem Vortag — ein Vergleich damit ließ in diesem Fenster
   * Gutscheine durch, die seit Mitternacht abgelaufen sind.
   *
   * Die Uhr wird nur um die Einlösung selbst gestellt (Anmelden und Ausstellen laufen
   * mit der echten Uhr) und es wird nur `Date` gefälscht: Wer auch die Timer fälscht,
   * lässt DB-Treiber und Fastify hängen.
   */
  describe('Ablaufdatum zählt nach dem Wiener Kalendertag, nicht nach dem UTC-Datum', () => {
    async function einloesenUm(wienerZeit: string, id: string, einloesungCent: number) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(wienerZeit))
      try {
        // iat/exp des Tokens hängen an der Uhr (Test-Token: 1 h): Die Anmeldung vom
        // Testbeginn wäre für ein Prüfdatum in der Zukunft schon abgelaufen (401). Darum
        // unter der gestellten Uhr neu ausstellen — der Test hängt so nicht am heutigen Datum.
        const { sub, mandantId } = srv.fastify.jwt.decode<{ sub: string; mandantId: string }>(token)!
        return await einloesen(id, einloesungCent, false, srv.authHeader({ sub, mandantId }))
      } finally {
        vi.useRealTimers()
      }
    }

    it.each([
      { zeit: '2026-10-07T00:00:00+02:00', gueltigBis: '2026-10-06', fall: 'Sommerzeit, erste Sekunde des Folgetags' },
      { zeit: '2026-10-07T00:30:00+02:00', gueltigBis: '2026-10-06', fall: 'Sommerzeit, mitten im Fenster' },
      { zeit: '2026-10-07T01:59:59+02:00', gueltigBis: '2026-10-06', fall: 'Sommerzeit, letzte Sekunde im Fenster' },
      { zeit: '2026-10-07T02:00:00+02:00', gueltigBis: '2026-10-06', fall: 'Sommerzeit, Fenster geschlossen (Kontrolle)' },
      { zeit: '2026-11-15T00:00:00+01:00', gueltigBis: '2026-11-14', fall: 'Winterzeit, erste Sekunde des Folgetags' },
      { zeit: '2026-11-15T00:59:59+01:00', gueltigBis: '2026-11-14', fall: 'Winterzeit, letzte Sekunde im Fenster' },
    ])('lehnt einen am Vortag abgelaufenen Gutschein ab — $fall ($zeit)', async ({ zeit, gueltigBis }) => {
      const gs = await erstelle(2000, undefined, gueltigBis)

      const res = await einloesenUm(zeit, gs.id, 500)
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toContain('abgelaufen')

      // nichts verbucht: voller Restwert, Status unverändert
      const danach = await srv.fastify.inject({
        method: 'GET', url: `/api/gutscheine/${gs.id}`, headers: auth(),
      })
      const unveraendert = danach.json() as GutscheinResponse
      expect(unveraendert.restCent).toBe(2000)
      expect(unveraendert.status).toBe('aktiv')
    })

    it.each([
      { zeit: '2026-10-06T23:59:59+02:00', gueltigBis: '2026-10-06', fall: 'Sommerzeit, letzte Sekunde des Gültigkeitstags' },
      { zeit: '2026-10-07T00:30:00+02:00', gueltigBis: '2026-10-07', fall: 'Sommerzeit, im Fenster, Gültigkeitstag ist heute' },
      { zeit: '2026-11-15T00:30:00+01:00', gueltigBis: '2026-11-15', fall: 'Winterzeit, im Fenster, Gültigkeitstag ist heute' },
    ])('löst am Gültigkeitstag selbst noch ein — $fall ($zeit)', async ({ zeit, gueltigBis }) => {
      const gs = await erstelle(2000, undefined, gueltigBis)

      const res = await einloesenUm(zeit, gs.id, 500)
      expect(res.statusCode).toBe(200)
      const nach = (res.json() as GutscheinEinloesungResult).gutschein
      expect(nach.restCent).toBe(1500)
      expect(nach.status).toBe('teileingeloest')
    })
  })

  it('protokolliert Einlösungs-Buchungen', async () => {
    const gs = await erstelle(3000)
    await einloesen(gs.id, 1000)
    await einloesen(gs.id, 500)
    const res = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/${gs.id}/buchungen`, headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const buchungen = res.json() as unknown[]
    // mindestens die beiden Einlösungen
    expect(buchungen.length).toBeGreaterThanOrEqual(2)
  })
  it('Journal: Codewechsel dokumentiert + tagesaktuelle Offen-Summe + CSV-Export', async () => {
    // Frische Ausgangslage in DIESEM Test nicht nötig — das Journal zählt
    // mandantenweit; wir prüfen relativ (Deltas + Vorhandensein der Einträge).
    const gs = await erstelle(5000, 'JRNL-TEST-01')
    const res = await einloesen(gs.id, 2000, true)
    expect(res.statusCode).toBe(200)
    const result = res.json() as GutscheinEinloesungResult
    expect(result.restGutschein).toBeTruthy()
    const restCode = result.restGutschein!.code

    const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
    const jr = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/journal?von=${heute}&bis=${heute}`, headers: auth(),
    })
    expect(jr.statusCode).toBe(200)
    const journal = jr.json() as {
      eintraege: { typ: string; code: string; verknuepfterCode: string | null; betragCent: number; restCentNach: number }[]
      offen: { anzahl: number; summeCent: number }
    }

    // Der Codewechsel ist als eigener Journaleintrag dokumentiert: alter Code → neuer Code
    const wechsel = journal.eintraege.find(e => e.typ === 'restgutschein' && e.code === 'JRNL-TEST-01')
    expect(wechsel).toBeTruthy()
    expect(wechsel!.verknuepfterCode).toBe(restCode)
    // Ausstellung + Einlösung des Originals stehen ebenfalls drin
    expect(journal.eintraege.some(e => e.typ === 'ausstellung' && e.code === 'JRNL-TEST-01' && e.betragCent === 5000)).toBe(true)
    expect(journal.eintraege.some(e => e.typ === 'einloesung'  && e.code === 'JRNL-TEST-01' && e.betragCent === -2000)).toBe(true)
    // Ausstellung des Restgutscheins über 30 €
    expect(journal.eintraege.some(e => e.typ === 'ausstellung' && e.code === restCode && e.betragCent === 3000)).toBe(true)

    // Offen-Summe enthält den 30-€-Rest (weitere offene Test-Gutscheine möglich → >=)
    expect(journal.offen.summeCent).toBeGreaterThanOrEqual(3000)
    expect(journal.offen.anzahl).toBeGreaterThanOrEqual(1)

    // CSV-Export liefert eine Datei mit Kopfzeile und dem Codewechsel
    const csv = await srv.fastify.inject({
      method: 'GET', url: `/api/gutscheine/journal.csv?von=${heute}&bis=${heute}`, headers: auth(),
    })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain('Datum;Vorgang;Gutschein-Code')
    expect(csv.body).toContain('JRNL-TEST-01')
    expect(csv.body).toContain(restCode)
    expect(csv.body).toContain('Offene Gutscheine (Stichtag')
  })
})
