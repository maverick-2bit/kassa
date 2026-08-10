/**
 * Integrationstest: Tischbindung + Doppelbelegungs-Schutz bei Reservierungen.
 *
 * Geprüft: echte Tisch-Zuordnung (tischId), Überschneidungs-Erkennung in allen
 * Varianten (exakt gleich, teilweise, umschließend, direkt anschließend = frei),
 * storniert/nicht_erschienen geben den Tisch wieder frei, Bearbeiten schließt
 * die eigene Reservierung aus, Verfügbarkeits-Abfrage, sowie die Online-Regeln
 * (nur freigegebene Tische, Doppelbelegung auch online blockiert).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen, mandanten, tischplanBereiche, tischplanElemente } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@reservierung-tisch.at'
const ADMIN_PASSWORT = 'reservierung-tisch-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RT-PW' }),
  } as unknown as FinanzOnlineClient
}

describe('Reservierung: Tischbindung + Doppelbelegung (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let tischA: string   // online freigegeben, 4 Plätze
  let tischB: string   // NICHT online freigegeben, 2 Plätze
  let mandantId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  const reservieren = (payload: Record<string, unknown>) =>
    srv.fastify.inject({ method: 'POST', url: '/api/reservierungen', headers: auth(), payload })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Reservierung GmbH',
        uid:        'ATU99999912',
        kassenId:   'RT-001',
        finanzOnline: { teilnehmerId: 'TID-RT', benutzerkennung: 'BID-RT', pin: 'PIN-RT' },
        umgebung: 'test',
        admin: { name: 'RT Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id
    mandantId = login.mandant.id

    // Modul + Online-Buchung aktivieren
    await idb.db.update(mandanten).set({ modulReservierungenAktiv: true }).where(eq(mandanten.id, mandantId))
    await idb.db.update(kassen).set({ onlineBuchungAktiv: true }).where(eq(kassen.id, kasseId))

    const [bereich] = await idb.db.insert(tischplanBereiche)
      .values({ mandantId, kasseId, name: 'Gastgarten' }).returning()

    const [a] = await idb.db.insert(tischplanElemente).values({
      mandantId, kasseId, bereichId: bereich!.id, bezeichnung: 'T1',
      onlineReservierbar: true, plaetze: 4,
    }).returning()
    const [b] = await idb.db.insert(tischplanElemente).values({
      mandantId, kasseId, bereichId: bereich!.id, bezeichnung: 'T2',
      onlineReservierbar: false, plaetze: 2,
    }).returning()
    tischA = a!.id
    tischB = b!.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Reservierung mit Tisch: tischId gespeichert, Label automatisch übernommen', async () => {
    const res = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '18:00', dauer: 120,
      personenAnzahl: 4, name: 'Huber', tischId: tischA,
    })
    expect(res.statusCode).toBe(201)
    const r = res.json()
    expect(r.tischId).toBe(tischA)
    expect(r.tischLabel).toBe('T1')   // aus dem Tischplan übernommen
  })

  it('Überschneidung am selben Tisch wird mit 409 abgelehnt', async () => {
    // 18:00–20:00 liegt bereits (aus dem Test davor)
    const exakt = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '18:00', dauer: 120,
      personenAnzahl: 2, name: 'Gleich', tischId: tischA,
    })
    expect(exakt.statusCode).toBe(409)
    expect(exakt.json().fehler).toContain('bereits reserviert')

    const teilweise = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '19:00', dauer: 60,
      personenAnzahl: 2, name: 'Überlappt', tischId: tischA,
    })
    expect(teilweise.statusCode).toBe(409)

    const umschliessend = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '17:00', dauer: 240,
      personenAnzahl: 2, name: 'Umschließt', tischId: tischA,
    })
    expect(umschliessend.statusCode).toBe(409)
  })

  it('direkt anschließend (20:00) und anderer Tag/Tisch sind frei', async () => {
    const anschluss = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '20:00', dauer: 90,
      personenAnzahl: 2, name: 'Danach', tischId: tischA,
    })
    expect(anschluss.statusCode).toBe(201)

    const andererTag = await reservieren({
      kasseId, datum: '2026-08-02', zeitVon: '18:00', dauer: 120,
      personenAnzahl: 2, name: 'Morgen', tischId: tischA,
    })
    expect(andererTag.statusCode).toBe(201)

    const andererTisch = await reservieren({
      kasseId, datum: '2026-08-01', zeitVon: '18:00', dauer: 120,
      personenAnzahl: 2, name: 'Nebentisch', tischId: tischB,
    })
    expect(andererTisch.statusCode).toBe(201)
  })

  it('ohne Tisch (Freitext/kein Tisch) bleibt alles erlaubt', async () => {
    for (const name of ['Ohne1', 'Ohne2']) {
      const res = await reservieren({
        kasseId, datum: '2026-08-01', zeitVon: '18:00', dauer: 120,
        personenAnzahl: 2, name,
      })
      expect(res.statusCode).toBe(201)
    }
  })

  it('Storniert gibt den Tisch wieder frei', async () => {
    const belegt = await reservieren({
      kasseId, datum: '2026-08-05', zeitVon: '12:00', dauer: 90,
      personenAnzahl: 2, name: 'Storniert später', tischId: tischA,
    })
    expect(belegt.statusCode).toBe(201)

    const blockiert = await reservieren({
      kasseId, datum: '2026-08-05', zeitVon: '12:30', dauer: 60,
      personenAnzahl: 2, name: 'Blockiert', tischId: tischA,
    })
    expect(blockiert.statusCode).toBe(409)

    await srv.fastify.inject({
      method: 'PATCH', url: `/api/reservierungen/${belegt.json().id}`, headers: auth(),
      payload: { status: 'storniert' },
    })

    const jetztFrei = await reservieren({
      kasseId, datum: '2026-08-05', zeitVon: '12:30', dauer: 60,
      personenAnzahl: 2, name: 'Jetzt frei', tischId: tischA,
    })
    expect(jetztFrei.statusCode).toBe(201)
  })

  it('Bearbeiten der eigenen Reservierung kollidiert nicht mit sich selbst', async () => {
    const eigene = await reservieren({
      kasseId, datum: '2026-08-10', zeitVon: '19:00', dauer: 90,
      personenAnzahl: 2, name: 'Verschiebt sich', tischId: tischA,
    })
    const id = eigene.json().id

    // Personenzahl ändern — Zeit bleibt, darf NICHT mit sich selbst kollidieren
    const patch1 = await srv.fastify.inject({
      method: 'PATCH', url: `/api/reservierungen/${id}`, headers: auth(),
      payload: { personenAnzahl: 4 },
    })
    expect(patch1.statusCode).toBe(200)

    // Innerhalb desselben Tisches auf eine freie Zeit verschieben
    const patch2 = await srv.fastify.inject({
      method: 'PATCH', url: `/api/reservierungen/${id}`, headers: auth(),
      payload: { zeitVon: '21:00' },
    })
    expect(patch2.statusCode).toBe(200)
  })

  it('Verfügbarkeits-Abfrage meldet frei/belegt samt Belegung', async () => {
    const res = await srv.fastify.inject({
      method: 'GET', headers: auth(),
      url: `/api/reservierungen/tische?kasseId=${kasseId}&datum=2026-08-01&zeitVon=18:30&dauer=60`,
    })
    expect(res.statusCode).toBe(200)
    const tische = res.json() as Array<{ id: string; bezeichnung: string; frei: boolean; belegtDurch?: string; plaetze: number }>

    const t1 = tische.find(t => t.id === tischA)!
    expect(t1.frei).toBe(false)
    expect(t1.belegtDurch).toContain('Huber')
    expect(t1.plaetze).toBe(4)

    const t2 = tische.find(t => t.id === tischB)!
    expect(t2.frei).toBe(false)     // „Nebentisch" 18:00–20:00
  })

  it('Online: nur freigegebene Tische, Doppelbelegung ebenfalls blockiert', async () => {
    // Öffentliche Liste zeigt NUR T1 (freigegeben) und nur wenn frei
    const frei = await srv.fastify.inject({
      method: 'GET',
      url: `/api/buchung/${kasseId}/tische?datum=2026-08-20&zeitVon=18:00&dauer=90&personen=4`,
    })
    expect(frei.statusCode).toBe(200)
    const liste = frei.json() as Array<{ id: string; bezeichnung: string }>
    expect(liste.map(t => t.id)).toEqual([tischA])

    // Gast bucht T1
    const buchung = await srv.fastify.inject({
      method: 'POST', url: `/api/buchung/${kasseId}`,
      payload: { datum: '2026-08-20', zeitVon: '18:00', personenAnzahl: 4, name: 'Online-Gast', tischId: tischA },
    })
    expect(buchung.statusCode).toBe(201)

    // Zweiter Gast zur selben Zeit → 409
    const doppelt = await srv.fastify.inject({
      method: 'POST', url: `/api/buchung/${kasseId}`,
      payload: { datum: '2026-08-20', zeitVon: '18:30', personenAnzahl: 2, name: 'Zu spät', tischId: tischA },
    })
    expect(doppelt.statusCode).toBe(409)

    // Nicht freigegebener Tisch → 409 mit klarer Meldung
    const gesperrt = await srv.fastify.inject({
      method: 'POST', url: `/api/buchung/${kasseId}`,
      payload: { datum: '2026-08-21', zeitVon: '18:00', personenAnzahl: 2, name: 'Falscher Tisch', tischId: tischB },
    })
    expect(gesperrt.statusCode).toBe(409)
    expect(gesperrt.json().fehler).toContain('nicht für Online-Reservierungen freigegeben')

    // Zu kleiner Tisch fällt aus der Vorschlagsliste (T1 hat 4 Plätze)
    const grosseGruppe = await srv.fastify.inject({
      method: 'GET',
      url: `/api/buchung/${kasseId}/tische?datum=2026-08-25&zeitVon=18:00&dauer=90&personen=6`,
    })
    expect(grosseGruppe.json()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Umrüstzeit fürs Neueindecken (v0.7.146)
  // -------------------------------------------------------------------------

  describe('Umrüstzeit', () => {
    const TAG = '2026-09-10'

    async function setzeUmruest(minuten: number) {
      await idb.db.update(mandanten).set({ umruestMinuten: minuten }).where(eq(mandanten.id, mandantId))
    }

    const verfuegbarkeit = (zeitVon: string, dauer: number) =>
      srv.fastify.inject({
        method: 'GET', headers: auth(),
        url: `/api/reservierungen/tische?kasseId=${kasseId}&datum=${TAG}&zeitVon=${zeitVon}&dauer=${dauer}`,
      })

    beforeAll(async () => {
      // Basis: 18:00–19:30 auf Tisch A
      const res = await reservieren({
        kasseId, datum: TAG, zeitVon: '18:00', dauer: 90,
        personenAnzahl: 2, name: 'Basis', tischId: tischA,
      })
      expect(res.statusCode).toBe(201)
    })

    afterAll(() => setzeUmruest(0))

    it('ohne Umrüstzeit ist der Tisch direkt im Anschluss buchbar', async () => {
      await setzeUmruest(0)
      const res = await reservieren({
        kasseId, datum: TAG, zeitVon: '19:30', dauer: 60,
        personenAnzahl: 2, name: 'Direkt danach', tischId: tischA,
      })
      expect(res.statusCode).toBe(201)
      // wieder entfernen, damit die folgenden Fälle auf der Basis aufsetzen
      await srv.fastify.inject({
        method: 'DELETE', url: `/api/reservierungen/${res.json().id}`, headers: auth(),
      })
    })

    it('mit 30 Min. Umrüstzeit ist derselbe Anschluss-Termin belegt', async () => {
      await setzeUmruest(30)
      const res = await reservieren({
        kasseId, datum: TAG, zeitVon: '19:30', dauer: 60,
        personenAnzahl: 2, name: 'Zu früh', tischId: tischA,
      })
      expect(res.statusCode).toBe(409)
      // Die gebuchte Zeit UND die Umrüstzeit müssen in der Meldung stehen,
      // sonst wirkt die Absage willkürlich.
      expect(res.json().fehler).toContain('18:00–19:30')
      expect(res.json().fehler).toContain('30 Min. Umrüstzeit')
    })

    it('nach Ablauf der Umrüstzeit ist der Tisch wieder frei', async () => {
      await setzeUmruest(30)
      const res = await reservieren({
        kasseId, datum: TAG, zeitVon: '20:00', dauer: 60,
        personenAnzahl: 2, name: 'Genau passend', tischId: tischA,
      })
      expect(res.statusCode).toBe(201)
      await srv.fastify.inject({
        method: 'DELETE', url: `/api/reservierungen/${res.json().id}`, headers: auth(),
      })
    })

    it('gilt auch VOR der Reservierung — die Umrüstzeit hängt an beiden', async () => {
      await setzeUmruest(30)
      // 16:15–17:45 endet 15 Min. vor der Basis um 18:00 → zu wenig zum Eindecken
      const zuKnapp = await reservieren({
        kasseId, datum: TAG, zeitVon: '16:15', dauer: 90,
        personenAnzahl: 2, name: 'Davor zu knapp', tischId: tischA,
      })
      expect(zuKnapp.statusCode).toBe(409)

      // 16:00–17:30 lässt exakt 30 Min. → passt
      const passt = await reservieren({
        kasseId, datum: TAG, zeitVon: '16:00', dauer: 90,
        personenAnzahl: 2, name: 'Davor passend', tischId: tischA,
      })
      expect(passt.statusCode).toBe(201)
      await srv.fastify.inject({
        method: 'DELETE', url: `/api/reservierungen/${passt.json().id}`, headers: auth(),
      })
    })

    it('Verfügbarkeitsliste und Speichern sind sich einig', async () => {
      // Der teuerste Fehler wäre: Auswahl zeigt „frei", Speichern antwortet 409.
      await setzeUmruest(30)
      const belegt = (await verfuegbarkeit('19:30', 60)).json() as Array<{ id: string; frei: boolean; belegtDurch?: string }>
      expect(belegt.find(t => t.id === tischA)!.frei).toBe(false)
      expect(belegt.find(t => t.id === tischA)!.belegtDurch).toContain('Basis')

      const frei = (await verfuegbarkeit('20:00', 60)).json() as Array<{ id: string; frei: boolean }>
      expect(frei.find(t => t.id === tischA)!.frei).toBe(true)

      // Und ohne Umrüstzeit ist 19:30 sofort wieder frei
      await setzeUmruest(0)
      const ohne = (await verfuegbarkeit('19:30', 60)).json() as Array<{ id: string; frei: boolean }>
      expect(ohne.find(t => t.id === tischA)!.frei).toBe(true)
    })

    it('wirkt auch bei der Online-Buchung durch den Gast', async () => {
      await setzeUmruest(30)
      const online = await srv.fastify.inject({
        method: 'GET',
        url: `/api/buchung/${kasseId}/tische?datum=${TAG}&zeitVon=19:30&dauer=60&personen=2`,
      })
      // T1 ist der einzige online freigegebene Tisch — und in der Umrüstzeit weg
      expect(online.json()).toEqual([])
    })
  })
})
