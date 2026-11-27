/**
 * Integrationstest: Auswertung → Belege über alle Kassen eines Betriebs, je Kasse getrennt.
 *
 * Ein Betrieb hat mehrere Kassen (Barkasse, Kellner-Geräte mit eigener Kasse). Die Belegliste
 * zeigte nur die Kasse des Geräts. `GET /api/belege/seite` liefert die Belege EINER frei
 * gewählten Kasse des Mandanten — mit Zeitraum, Suche und Paging — und sagt je Beleg, ob und
 * mit welchem Stornobeleg er storniert ist.
 *
 * Geprüft:
 *  - je Kasse getrennt: nie Belege einer anderen Kasse, nie eines anderen Mandanten
 *  - fremde / unbekannte Kasse → 404, ohne Recht „Belege einsehen" → 403
 *  - Paging (limit/offset, absteigend nach Belegnummer, `gesamt` für alle Treffer)
 *  - Suche nach Belegnummer, Betrag und Kunde; Zeitraum nach Wiener Kalendertag; Belegtypen
 *  - Storno läuft auf der Kasse des Originalbelegs (RKSV-Kette); `storniertDurch` kommt aus
 *    der Datenbank, auch wenn der Stornobeleg auf einer anderen Seite steht
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { BelegResponse, BelegSeite } from '@kassa/shared'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { userKassen, users } from '../../src/db/schema.js'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const PASSWORT = 'belege-je-kasse-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BJK-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Belege je Kasse ${nr} GmbH`,
    uid:        `ATU9999995${nr}`,
    kassenId:   `BJK-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-BJK-${nr}`, benutzerkennung: `BID-BJK-${nr}`, pin: `PIN-BJK-${nr}` },
    umgebung: 'test',
    admin: { name: `Admin ${nr}`, email: `admin${nr}@belege-je-kasse.at`, passwort: PASSWORT },
  }
}

/** Wiener Kalendertag eines Zeitpunkts (JJJJ-MM-TT) */
const wienerTag = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date(iso))

const tagVersetzt = (tag: string, tage: number) => {
  const d = new Date(`${tag}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + tage)
  return d.toISOString().slice(0, 10)
}

const UNBEKANNTE_KASSE = '00000000-0000-4000-8000-00000000beef'

describe('Belege je Kasse (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA: string, tokenB: string, tokenOhneRecht: string
  /** Barkasse und Kellner-Kasse von Mandant A, Kasse von Mandant B */
  let barkasse: string, kellnerKasse: string, kasseB: string

  const verkaufe: BelegResponse[] = []
  let kellnerBelege: BelegResponse[] = []
  let belegB: BelegResponse

  const auth = (t: string) => ({ authorization: `Bearer ${t}` })

  async function login(email: string): Promise<{ token: string; mandant: { id: string }; kassen: { id: string }[] }> {
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, passwort: PASSWORT } })
    if (res.statusCode !== 200) throw new Error(`Login ${email} (${res.statusCode}): ${res.body}`)
    return res.json()
  }

  async function verkauf(token: string, kasseId: string, cent: number, extra: Record<string, unknown> = {}): Promise<BelegResponse> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(token),
      payload: {
        kasseId,
        positionen: [{ bezeichnung: 'Spritzer', preisBruttoCent: cent, mwstSatz: 'normal', menge: 1 }],
        zahlung:    { barCent: cent, karteCent: 0, sonstigeCent: 0 },
        keinAutodruck: true,
        ...extra,
      },
    })
    if (res.statusCode !== 201) throw new Error(`Verkauf (${res.statusCode}): ${res.body}`)
    return res.json()
  }

  async function seite(token: string, query: Record<string, string | number>) {
    const p = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))
    return srv.fastify.inject({ method: 'GET', url: `/api/belege/seite?${p.toString()}`, headers: auth(token) })
  }

  async function seiteOk(query: Record<string, string | number>, token = tokenA): Promise<BelegSeite> {
    const res = await seite(token, query)
    expect(res.statusCode, res.body).toBe(200)
    return res.json()
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr),
      })
      if (res.statusCode !== 201) throw new Error(`Setup ${nr} (${res.statusCode}): ${res.body}`)
    }
    const a = await login('admin1@belege-je-kasse.at')
    const b = await login('admin2@belege-je-kasse.at')
    tokenA = a.token; barkasse = a.kassen[0]!.id
    tokenB = b.token; kasseB   = b.kassen[0]!.id

    // Zweite, eigene (signierende) Kasse von A — wie ein Kellner-Gerät
    const neu = await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(tokenA),
      payload: { kassenId: 'BJK-001-KELLNER', bezeichnung: 'Kellner 1', umgebung: 'test' },
    })
    if (neu.statusCode !== 201) throw new Error(`Kasse anlegen (${neu.statusCode}): ${neu.body}`)
    kellnerKasse = neu.json().kasseId

    // Benutzer von A ohne „Belege einsehen"
    await idb.db.insert(users).values({
      mandantId:      a.mandant.id,
      email:          'kellner@belege-je-kasse.at',
      passwordHash:   bcrypt.hashSync(PASSWORT, 10),
      name:           'Kellner ohne Belegrecht',
      rolle:          'kellner',
      berechtigungen: ['kasse', 'tische'],
    })
    tokenOhneRecht = (await login('kellner@belege-je-kasse.at')).token

    // Barkasse: fünf Verkäufe, einer mit Kunde
    for (const cent of [1000, 1234, 450, 990]) verkaufe.push(await verkauf(tokenA, barkasse, cent))
    verkaufe.push(await verkauf(tokenA, barkasse, 2500, {
      neuerKunde: { vorname: 'Erika', nachname: 'Musterfrau_100%' },
    }))
    // Kellner-Kasse: zwei Verkäufe
    kellnerBelege = [await verkauf(tokenA, kellnerKasse, 777), await verkauf(tokenA, kellnerKasse, 1234)]
    // Mandant B: gleicher Betrag wie bei A
    belegB = await verkauf(tokenB, kasseB, 1234)
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('liefert nur die Belege der gewählten Kasse — je Kasse getrennt', async () => {
    const bar = await seiteOk({ kasseId: barkasse, typen: 'Barzahlungsbeleg' })
    expect(bar.gesamt).toBe(5)
    expect(bar.belege.map(b => b.id).sort()).toEqual(verkaufe.map(b => b.id).sort())

    const kellner = await seiteOk({ kasseId: kellnerKasse, typen: 'Barzahlungsbeleg' })
    expect(kellner.gesamt).toBe(2)
    expect(kellner.belege.map(b => b.id).sort()).toEqual(kellnerBelege.map(b => b.id).sort())

    // Ohne Typ-Filter: auch der Startbeleg der Kasse, aber nichts von der anderen Kasse
    const alle = await seiteOk({ kasseId: kellnerKasse })
    expect(alle.belege.some(b => b.belegTyp === 'Startbeleg')).toBe(true)
    expect(alle.belege.every(b => !verkaufe.some(v => v.id === b.id))).toBe(true)
  })

  it('fremde und unbekannte Kasse → 404, nie Belege eines anderen Mandanten', async () => {
    const fremd = await seite(tokenA, { kasseId: kasseB })
    expect(fremd.statusCode).toBe(404)
    expect(fremd.json().fehler).toBe('Kasse nicht gefunden')
    expect(fremd.body).not.toContain(belegB.id)

    expect((await seite(tokenA, { kasseId: UNBEKANNTE_KASSE })).statusCode).toBe(404)
    expect((await seite(tokenB, { kasseId: barkasse })).statusCode).toBe(404)
  })

  it('ohne Recht „Belege einsehen" → 403', async () => {
    const res = await seite(tokenOhneRecht, { kasseId: barkasse })
    expect(res.statusCode).toBe(403)
  })

  it('ungültige Abfrage → 400', async () => {
    expect((await seite(tokenA, { kasseId: barkasse, von: '19.11.2026' })).statusCode).toBe(400)
    expect((await seite(tokenA, { kasseId: barkasse, limit: 500 })).statusCode).toBe(400)
    expect((await seite(tokenA, { kasseId: barkasse, offset: -1 })).statusCode).toBe(400)
  })

  it('Paging: absteigend nach Belegnummer, ohne Überschneidung, gesamt über alle Seiten', async () => {
    const s1 = await seiteOk({ kasseId: barkasse, typen: 'Barzahlungsbeleg', limit: 2, offset: 0 })
    const s2 = await seiteOk({ kasseId: barkasse, typen: 'Barzahlungsbeleg', limit: 2, offset: 2 })
    const s3 = await seiteOk({ kasseId: barkasse, typen: 'Barzahlungsbeleg', limit: 2, offset: 4 })
    expect([s1.gesamt, s2.gesamt, s3.gesamt]).toEqual([5, 5, 5])
    expect([s1.belege.length, s2.belege.length, s3.belege.length]).toEqual([2, 2, 1])

    const nummern = [...s1.belege, ...s2.belege, ...s3.belege].map(b => b.belegNummer)
    expect(nummern).toEqual([...nummern].sort((x, y) => y - x))
    expect(new Set(nummern).size).toBe(5)
  })

  it('Suche nach Belegnummer, Betrag und Kunde', async () => {
    const ziel = verkaufe[2]!   // 4,50 €
    const nachNummer = await seiteOk({ kasseId: barkasse, suche: `#${ziel.belegNummer}` })
    expect(nachNummer.belege.map(b => b.id)).toContain(ziel.id)

    // Betrag mit Komma — nur auf der gewählten Kasse, nicht der gleiche Betrag der Kellner-Kasse oder von B
    const nachBetrag = await seiteOk({ kasseId: barkasse, suche: '12,34' })
    expect(nachBetrag.belege.map(b => b.id)).toEqual([verkaufe[1]!.id])
    const ganzeEuro = await seiteOk({ kasseId: barkasse, suche: '25' })
    expect(ganzeEuro.belege.map(b => b.id)).toContain(verkaufe[4]!.id)

    const nachKunde = await seiteOk({ kasseId: barkasse, suche: 'musterfrau' })
    expect(nachKunde.belege.map(b => b.id)).toEqual([verkaufe[4]!.id])
    expect(nachKunde.belege[0]!.kunde?.bezeichnung).toMatch(/Musterfrau/)

    // LIKE-Platzhalter zählen wörtlich: „%" findet nur den Namen mit „%"
    expect((await seiteOk({ kasseId: barkasse, suche: '100%' })).belege.map(b => b.id)).toEqual([verkaufe[4]!.id])
    expect((await seiteOk({ kasseId: barkasse, suche: '_' })).belege.map(b => b.id)).toEqual([verkaufe[4]!.id])
    expect((await seiteOk({ kasseId: barkasse, suche: 'gibt-es-nicht' })).gesamt).toBe(0)
  })

  it('Zeitraum nach Wiener Kalendertag (von/bis inklusive)', async () => {
    const tag = wienerTag(verkaufe[0]!.belegDatum)
    const heute = await seiteOk({ kasseId: barkasse, typen: 'Barzahlungsbeleg', von: tag, bis: tag })
    expect(heute.gesamt).toBe(5)

    expect((await seiteOk({ kasseId: barkasse, von: tagVersetzt(tag, 1) })).gesamt).toBe(0)
    expect((await seiteOk({ kasseId: barkasse, bis: tagVersetzt(tag, -1) })).gesamt).toBe(0)
  })

  it('Storno läuft auf der Kasse des Originalbelegs; storniertDurch steht in der Liste', async () => {
    const original = kellnerBelege[0]!

    // Auf der falschen Kasse (Barkasse) gibt es den Beleg nicht — die RKSV-Kette bleibt sauber
    const falsch = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(tokenA),
      payload: { kasseId: barkasse, verweisBelegId: original.id },
    })
    expect(falsch.statusCode).toBe(404)

    const storno = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/storno', headers: auth(tokenA),
      payload: { kasseId: kellnerKasse, verweisBelegId: original.id, grund: 'Falsch boniert' },
    })
    expect(storno.statusCode, storno.body).toBe(201)
    const stornoBeleg = storno.json() as BelegResponse

    // Nur die Seite mit dem Original laden (der Stornobeleg steht auf einer anderen Seite)
    const nurOriginal = await seiteOk({ kasseId: kellnerKasse, typen: 'Barzahlungsbeleg' })
    const eintrag = nurOriginal.belege.find(b => b.id === original.id)
    expect(eintrag?.storniertDurch).toEqual({ id: stornoBeleg.id, belegNummer: stornoBeleg.belegNummer })
    expect(nurOriginal.belege.find(b => b.id === kellnerBelege[1]!.id)?.storniertDurch).toBeUndefined()

    // Der Stornobeleg steht auf der Kellner-Kasse, nicht auf der Barkasse
    const stornos = await seiteOk({ kasseId: kellnerKasse, typen: 'Stornobeleg' })
    expect(stornos.belege.map(b => b.id)).toEqual([stornoBeleg.id])
    expect((await seiteOk({ kasseId: barkasse, typen: 'Stornobeleg' })).gesamt).toBe(0)

    // Betragssuche findet Original und Storno (negativer Betrag)
    const nachBetrag = await seiteOk({ kasseId: kellnerKasse, suche: '7,77' })
    expect(nachBetrag.belege.map(b => b.id).sort()).toEqual([original.id, stornoBeleg.id].sort())
  })

  describe('Kassen-Zuordnung des Benutzers', () => {
    const RECHTE = ['kasse', 'belege.lesen', 'belege.stornieren']
    let mandantA: string

    async function benutzer(name: string, kassen: string[], rechte = RECHTE): Promise<string> {
      const email = `${name}@belege-je-kasse.at`
      const [u] = await idb.db.insert(users).values({
        mandantId: mandantA, email, passwordHash: bcrypt.hashSync(PASSWORT, 4), name, rolle: 'kellner', berechtigungen: rechte,
      }).returning()
      for (const kasseId of kassen) await idb.db.insert(userKassen).values({ userId: u!.id, kasseId })
      return (await login(email)).token
    }
    const post = (token: string, pfad: string, payload: Record<string, unknown>) =>
      srv.fastify.inject({ method: 'POST', url: `/api/belege/${pfad}`, headers: auth(token), payload })

    beforeAll(async () => { mandantA = (await login('admin1@belege-je-kasse.at')).mandant.id })

    it('zugeordnet nur Kellner-Kasse: Barkasse gesperrt beim Ansehen, Storno und bei Spezialbelegen — nichts wird signiert', async () => {
      const t = await benutzer('nur-kellner', [kellnerKasse])
      expect((await seite(t, { kasseId: kellnerKasse })).statusCode).toBe(200)

      const vorher = (await seiteOk({ kasseId: barkasse })).gesamt
      const gesperrt = [
        await seite(t, { kasseId: barkasse }),
        await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${barkasse}`, headers: auth(t) }),
        await post(t, 'storno', { kasseId: barkasse, verweisBelegId: verkaufe[0]!.id }),
        await post(t, 'nullbeleg', { kasseId: barkasse }),
        await post(t, 'monatsbeleg', { kasseId: barkasse }),
        await post(t, 'jahresbeleg', { kasseId: barkasse }),
      ]
      for (const res of gesperrt) {
        expect(res.statusCode, res.body).toBe(403)
        expect(res.json().fehler).toMatch(/nicht zugeordnet/)
      }
      expect((await seiteOk({ kasseId: barkasse })).gesamt).toBe(vorher)
      // Fremder Mandant bleibt 404 (verrät nicht, dass es die Kasse gibt)
      expect((await seite(t, { kasseId: kasseB })).statusCode).toBe(404)
    })

    it('auf der zugeordneten Kasse läuft alles weiter (Storno)', async () => {
      const t = await benutzer('storniert', [kellnerKasse])
      const beleg = await verkauf(tokenA, kellnerKasse, 310)
      expect((await post(t, 'storno', { kasseId: kellnerKasse, verweisBelegId: beleg.id })).statusCode).toBe(201)
    })

    it('eine geänderte Zuordnung gilt sofort, ohne neue Anmeldung', async () => {
      const t = await benutzer('wechselt', [kellnerKasse])
      expect((await seite(t, { kasseId: barkasse })).statusCode).toBe(403)
      await idb.db.update(userKassen).set({ kasseId: barkasse }).where(eq(
        userKassen.userId, (await idb.db.select({ id: users.id }).from(users).where(eq(users.name, 'wechselt')))[0]!.id,
      ))
      expect((await seite(t, { kasseId: barkasse })).statusCode).toBe(200)
      expect((await seite(t, { kasseId: kellnerKasse })).statusCode).toBe(403)
    })

    it('Einstellungs-Recht: alle Kassen trotz Zuordnung; ohne jede Zuordnung nicht eingeschränkt', async () => {
      const chef = await benutzer('chef', [kellnerKasse], [...RECHTE, 'einstellungen'])
      expect((await seite(chef, { kasseId: barkasse })).statusCode).toBe(200)
      const ohne = await benutzer('ohne-zuordnung', [])
      expect((await seite(ohne, { kasseId: barkasse })).statusCode).toBe(200)
    })

    it('Altbestand: eine zugeordnete Kasse eines anderen Mandanten zählt nicht als Zuordnung', async () => {
      const t = await benutzer('altbestand', [kasseB])
      expect((await seite(t, { kasseId: barkasse })).statusCode).toBe(200)
      expect((await seite(t, { kasseId: kasseB })).statusCode).toBe(404)
    })
  })

  it('Belegtypen-Filter (Fälligkeit Monatsbeleg)', async () => {
    const spezial = await seiteOk({ kasseId: barkasse, typen: 'Monatsbeleg,Jahresbeleg,Startbeleg', limit: 20 })
    expect(spezial.belege.length).toBeGreaterThan(0)
    expect(spezial.belege.every(b => ['Monatsbeleg', 'Jahresbeleg', 'Startbeleg'].includes(b.belegTyp))).toBe(true)
  })
})
