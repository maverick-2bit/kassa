/**
 * Integrationstest: IDs aus dem Request gegen den Mandanten prüfen.
 *
 * Drei JWT-Routen übernahmen IDs ungeprüft — zusammengesetzte FKs mit
 * mandant_id gibt es nicht:
 *
 *  1. POST/PUT /api/users schrieben kassenIds in user_kassen. Eine FREMDE Kasse
 *     stand danach in der Login-Antwort des Benutzers (id, Kassen-ID,
 *     Bezeichnung, Umgebung), eine UNBEKANNTE endete als FK-Verletzung (500) —
 *     beim Anlegen erst NACHDEM der Benutzer angelegt war, beim Ändern erst
 *     NACHDEM die alte Zuordnung gelöscht war.
 *  2. POST /api/display bespielte das Kundendisplay jeder Kasse: der SSE-Kanal
 *     ist nur nach kasseId geschlüsselt, GET /sse/display ist öffentlich.
 *  3. PUT /api/kassen/:kasseId/pos-config speicherte fremde Warengruppen- und
 *     Bonierdrucker-IDs in den Sichtbarkeits-Tabellen, unbekannte → 500.
 *
 * Erwartet: fremde und unbekannte IDs → 404, keine Zeile, kein Display-Event,
 * auch der Rest der Anfrage bleibt ungespeichert. Eigene IDs funktionieren
 * weiter. Altbestand mit fremden IDs taucht in keiner Antwort auf und lässt
 * sich weiter speichern.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import {
  bonierdrucker, kasseBonierdruckerSichtbarkeit, kassekategorieSichtbarkeit, kassen, kategorien,
  userKassen, users,
} from '../../src/db/schema.js'
import { onDisplayEvent, type DisplayEvent } from '../../src/sse/display-event-bus.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'MIDS-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: number) {
  return {
    firmenname: `Mandanten-IDs ${nr} GmbH`,
    uid:        `ATU9999993${nr}`,
    kassenId:   `MIDS-00${nr}`,
    finanzOnline: {
      teilnehmerId:    `TID-MIDS-${nr}`,
      benutzerkennung: `BID-MIDS-${nr}`,
      pin:             `PIN-MIDS-${nr}`,
    },
    umgebung: 'test',
    admin: {
      name:     `Admin ${nr}`,
      email:    `admin${nr}@mandant-ids.at`,
      passwort: 'mandant-ids-passwort-123',
    },
  }
}

/** Gültige UUIDs, zu denen es nichts gibt (→ vor dem Fix FK-Verletzung = 500) */
const UNBEKANNTE_KASSE     = '00000000-0000-4000-8000-00000000abcd'
const UNBEKANNTE_KATEGORIE = '00000000-0000-4000-8000-00000000cafe'
const UNBEKANNTER_DRUCKER  = '00000000-0000-4000-8000-00000000beef'

const KELLNER_PASSWORT = 'kellner-passwort-123'

describe('IDs aus dem Request gegen den Mandanten prüfen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA: string
  let mandantA: string, mandantB: string
  let kasseA: string, kasseB: string
  /** Zweite Kasse von Mandant A — eigene Kasse zum Umhängen */
  let kasseA2: string
  let kategorieA: string, kategorieB: string
  let bonierdruckerA: string, bonierdruckerB: string

  const authA = () => ({ authorization: `Bearer ${tokenA}` })

  /** Zusätzliche Kasse direkt in der DB — signiert wird darauf nie */
  const weitereKasse = async (mandantId: string, kassenId: string): Promise<string> => {
    const [kasse] = await idb.db.insert(kassen).values({
      mandantId,
      kassenId,
      seeZertifikatDer: 'test',
      seePrivateKeyEnc: 'test',
      seeZertifikatSn:  'test',
      seeGueltigBis:    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    }).returning()
    return kasse!.id
  }

  const anzahlBenutzer = async (): Promise<number> =>
    (await idb.db.select({ id: users.id }).from(users)).length
  const anzahlZuordnungen = async (): Promise<number> =>
    (await idb.db.select({ userId: userKassen.userId }).from(userKassen)).length
  const kassenVon = async (userId: string): Promise<string[]> =>
    (await idb.db.select({ kasseId: userKassen.kasseId }).from(userKassen)
      .where(eq(userKassen.userId, userId))).map(z => z.kasseId).sort()
  const nameVon = async (userId: string): Promise<string | undefined> =>
    (await idb.db.select({ name: users.name }).from(users).where(eq(users.id, userId)))[0]?.name

  let kellnerNr = 0
  /** Anmeldbarer Kellner (E-Mail + Passwort) — Adresse je Aufruf eindeutig */
  const kellnerDaten = (kassenIds: string[]) => {
    kellnerNr++
    return {
      name:           `Kellner ${kellnerNr}`,
      email:          `kellner${kellnerNr}@mandant-ids.at`,
      passwort:       KELLNER_PASSWORT,
      rolle:          'kellner',
      berechtigungen: ['kasse'],
      kassenIds,
    }
  }
  const legeKellnerAn = async (kassenIds: string[]): Promise<{ id: string; name: string; email: string }> => {
    const daten = kellnerDaten(kassenIds)
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/users', headers: authA(), payload: daten,
    })
    expect(res.statusCode, res.body).toBe(201)
    return { id: res.json().id, name: daten.name, email: daten.email }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    for (const nr of [1, 2] as const) {
      const setupRes = await srv.fastify.inject({
        method: 'POST', url: '/api/setup', payload: setupInput(nr),
      })
      if (setupRes.statusCode !== 201) {
        throw new Error(`Setup ${nr} fehlgeschlagen (${setupRes.statusCode}): ${setupRes.body}`)
      }
      const loginRes = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: `admin${nr}@mandant-ids.at`, passwort: 'mandant-ids-passwort-123' },
      })
      if (loginRes.statusCode !== 200) {
        throw new Error(`Login ${nr} fehlgeschlagen (${loginRes.statusCode}): ${loginRes.body}`)
      }
      const login = loginRes.json()
      if (nr === 1) { tokenA = login.token; mandantA = login.mandant.id; kasseA = login.kassen[0].id }
      else          { mandantB = login.mandant.id; kasseB = login.kassen[0].id }
    }

    kasseA2 = await weitereKasse(mandantA, 'MIDS-001-B')

    const [katA] = await idb.db.insert(kategorien).values({ mandantId: mandantA, name: 'Getränke' }).returning()
    const [katB] = await idb.db.insert(kategorien).values({ mandantId: mandantB, name: 'Speisen' }).returning()
    kategorieA = katA!.id
    kategorieB = katB!.id

    const [bdA] = await idb.db.insert(bonierdrucker)
      .values({ mandantId: mandantA, name: 'Schank', ip: '10.0.0.11' }).returning()
    const [bdB] = await idb.db.insert(bonierdrucker)
      .values({ mandantId: mandantB, name: 'Küche', ip: '10.0.0.12' }).returning()
    bonierdruckerA = bdA!.id
    bonierdruckerB = bdB!.id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('Voraussetzung: zwei Mandanten mit je eigener Kasse', () => {
    expect(kasseA).toBeTruthy()
    expect(kasseB).toBeTruthy()
    expect(kasseA).not.toBe(kasseB)
    expect(mandantA).not.toBe(mandantB)
  })

  // -------------------------------------------------------------------------
  // 1. Kassen-Zuordnung der Benutzer
  // -------------------------------------------------------------------------

  const fremdeKassen = [
    ['fremder',             () => [kasseB]],
    ['unbekannter',         () => [UNBEKANNTE_KASSE]],
    ['eigener und fremder', () => [kasseA, kasseB]],
  ] as const

  describe('Benutzer anlegen (POST /api/users)', () => {
    it.each(fremdeKassen)('mit %s Kasse → 404, kein Benutzer, keine Zuordnung', async (_art, kassenIds) => {
      const benutzerVorher    = await anzahlBenutzer()
      const zuordnungenVorher = await anzahlZuordnungen()

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: authA(), payload: kellnerDaten(kassenIds()),
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
      expect(await anzahlBenutzer()).toBe(benutzerVorher)
      expect(await anzahlZuordnungen()).toBe(zuordnungenVorher)
    })

    it('mit eigener Kasse → 201, Zuordnung gespeichert', async () => {
      const kellner = await legeKellnerAn([kasseA])
      expect(await kassenVon(kellner.id)).toEqual([kasseA])
    })

    it('dieselbe Kasse doppelt → 201 mit einer Zuordnung (statt Primärschlüssel-Verletzung)', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: authA(), payload: kellnerDaten([kasseA, kasseA]),
      })

      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().kassenIds).toEqual([kasseA])
      expect(await kassenVon(res.json().id)).toEqual([kasseA])
    })
  })

  describe('Benutzer ändern (PUT /api/users/:id)', () => {
    let kellner: { id: string; name: string }

    beforeAll(async () => {
      kellner = await legeKellnerAn([kasseA])
    })

    it.each(fremdeKassen)('mit %s Kasse → 404, Name und Zuordnung unverändert', async (_art, kassenIds) => {
      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${kellner.id}`, headers: authA(),
        payload: { name: 'Umbenannt', kassenIds: kassenIds() },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
      expect(await kassenVon(kellner.id)).toEqual([kasseA])
      expect(await nameVon(kellner.id)).toBe(kellner.name)
    })

    it('mit zweiter eigener Kasse → 200, Zuordnung ersetzt', async () => {
      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${kellner.id}`, headers: authA(),
        payload: { kassenIds: [kasseA2] },
      })

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().kassenIds).toEqual([kasseA2])
      expect(await kassenVon(kellner.id)).toEqual([kasseA2])
    })
  })

  describe('Zuordnung scheitert beim Speichern (Fehler-Injektion)', () => {
    // Die DB lehnt die Zuordnung zu dieser (eigenen) Kasse per Trigger ab — steht
    // für jeden Fehler NACH dem Anlegen des Benutzers bzw. NACH dem Löschen der
    // alten Zuordnung, z. B. eine zwischen Prüfung und Speichern gelöschte Kasse.
    let stoerKasse: string

    beforeAll(async () => {
      stoerKasse = await weitereKasse(mandantA, 'MIDS-001-STOER')
      await idb.db.execute(sql.raw(`
        CREATE FUNCTION test_zuordnung_fehler() RETURNS trigger AS $$
        BEGIN
          IF NEW.kasse_id = '${stoerKasse}' THEN RAISE EXCEPTION 'Testfehler: Zuordnung abgelehnt'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`))
      await idb.db.execute(sql.raw(
        'CREATE TRIGGER test_zuordnung_fehler BEFORE INSERT ON user_kassen FOR EACH ROW EXECUTE FUNCTION test_zuordnung_fehler()'))
    })

    afterAll(async () => {
      await idb.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_zuordnung_fehler ON user_kassen'))
      await idb.db.execute(sql.raw('DROP FUNCTION IF EXISTS test_zuordnung_fehler()'))
    })

    it('Anlegen → 500, kein Benutzer ohne Kassen zurückgeblieben', async () => {
      const benutzerVorher = await anzahlBenutzer()

      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/users', headers: authA(), payload: kellnerDaten([stoerKasse]),
      })

      expect(res.statusCode).toBe(500)
      expect(await anzahlBenutzer()).toBe(benutzerVorher)
    })

    it('Ändern → 500, alte Zuordnung und Name bleiben', async () => {
      const kellner = await legeKellnerAn([kasseA])

      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${kellner.id}`, headers: authA(),
        payload: { name: 'Umbenannt', kassenIds: [stoerKasse] },
      })

      expect(res.statusCode).toBe(500)
      expect(await kassenVon(kellner.id)).toEqual([kasseA])
      expect(await nameVon(kellner.id)).toBe(kellner.name)
    })
  })

  describe('Altbestand: fremde Kasse steht schon in user_kassen', () => {
    let kellner: { id: string; email: string }

    beforeAll(async () => {
      kellner = await legeKellnerAn([kasseA])
      // So konnte die Zuordnung vor der Prüfung entstehen
      await idb.db.insert(userKassen).values({ userId: kellner.id, kasseId: kasseB })
    })

    const kassenIdsInDerListe = async (): Promise<string[] | undefined> => {
      const res = await srv.fastify.inject({ method: 'GET', url: '/api/users', headers: authA() })
      expect(res.statusCode).toBe(200)
      return (res.json() as Array<{ id: string; kassenIds: string[] }>)
        .find(u => u.id === kellner.id)?.kassenIds
    }

    it('Login des Kellners liefert die fremde Kasse nicht mit', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: kellner.email, passwort: KELLNER_PASSWORT },
      })

      expect(res.statusCode, res.body).toBe(200)
      expect((res.json().kassen as Array<{ id: string }>).map(k => k.id)).toEqual([kasseA])
      expect(res.json().user.kassenIds).toEqual([kasseA])
    })

    it('Benutzerliste zeigt die fremde Kasse nicht', async () => {
      expect(await kassenIdsInDerListe()).toEqual([kasseA])
    })

    it('Speichern mit der angezeigten Liste klappt und räumt den Altbestand ab', async () => {
      // Die Benutzerverwaltung schickt die geladenen kassenIds beim Speichern zurück
      const res = await srv.fastify.inject({
        method: 'PUT', url: `/api/users/${kellner.id}`, headers: authA(),
        payload: { name: 'Kellner mit Altbestand', kassenIds: await kassenIdsInDerListe() },
      })

      expect(res.statusCode, res.body).toBe(200)
      expect(await kassenVon(kellner.id)).toEqual([kasseA])
    })
  })

  // -------------------------------------------------------------------------
  // 2. Kundendisplay
  // -------------------------------------------------------------------------

  describe('Kundendisplay bespielen (POST /api/display)', () => {
    const warenkorb = {
      typ: 'warenkorb', positionen: [{ bezeichnung: 'Bier', menge: 2, preisCent: 450 }], summeCent: 900,
    } as const

    /** Hört mit wie ein Kundendisplay an GET /sse/display?kasseId */
    const lausche = (kasseId: string) => {
      const empfangen: DisplayEvent[] = []
      const abmelden = onDisplayEvent(kasseId, ev => empfangen.push(ev))
      return { empfangen, abmelden }
    }

    it.each([
      ['fremden',    () => kasseB],
      ['unbekannten', () => UNBEKANNTE_KASSE],
    ])('an der %s Kasse → 404, das Display bekommt nichts', async (_art, kasse) => {
      const display = lausche(kasse())
      try {
        const res = await srv.fastify.inject({
          method: 'POST', url: '/api/display', headers: authA(),
          payload: { kasseId: kasse(), event: warenkorb },
        })

        expect(res.statusCode).toBe(404)
        expect(res.json()).toEqual({ fehler: 'Kasse nicht gefunden' })
        expect(display.empfangen).toEqual([])
      } finally {
        display.abmelden()
      }
    })

    it('an der eigenen Kasse → 200, das Display bekommt den Warenkorb', async () => {
      const display = lausche(kasseA)
      try {
        const res = await srv.fastify.inject({
          method: 'POST', url: '/api/display', headers: authA(),
          payload: { kasseId: kasseA, event: warenkorb },
        })

        expect(res.statusCode, res.body).toBe(200)
        expect(res.json()).toEqual({ ok: true })
        expect(display.empfangen).toEqual([warenkorb])
      } finally {
        display.abmelden()
      }
    })
  })

  // -------------------------------------------------------------------------
  // 3. POS-Konfiguration: Sichtbarkeit von Warengruppen und Bonierdruckern
  // -------------------------------------------------------------------------

  const posConfig = (payload: Record<string, unknown>) => srv.fastify.inject({
    method: 'PUT', url: `/api/kassen/${kasseA}/pos-config`, headers: authA(), payload,
  })
  const artikelProZeile = async (): Promise<number | undefined> =>
    (await idb.db.select({ n: kassen.artikelProZeile }).from(kassen).where(eq(kassen.id, kasseA)))[0]?.n
  const sichtbareKategorien = async (): Promise<string[]> =>
    (await idb.db.select({ id: kassekategorieSichtbarkeit.kategorieId }).from(kassekategorieSichtbarkeit)
      .where(eq(kassekategorieSichtbarkeit.kasseId, kasseA))).map(z => z.id).sort()
  const sichtbareBonierdrucker = async (): Promise<string[]> =>
    (await idb.db.select({ id: kasseBonierdruckerSichtbarkeit.bonierdruckerId }).from(kasseBonierdruckerSichtbarkeit)
      .where(eq(kasseBonierdruckerSichtbarkeit.kasseId, kasseA))).map(z => z.id).sort()

  const sichtbarkeiten = [
    {
      name: 'Warengruppen', feld: 'sichtbareKategorieIds', fehler: 'Warengruppe nicht gefunden',
      eigene: () => kategorieA, fremde: () => kategorieB, unbekannte: UNBEKANNTE_KATEGORIE,
      gespeichert: () => sichtbareKategorien(),
    },
    {
      name: 'Bonierdrucker', feld: 'sichtbareBonierdruckerIds', fehler: 'Bonierdrucker nicht gefunden',
      eigene: () => bonierdruckerA, fremde: () => bonierdruckerB, unbekannte: UNBEKANNTER_DRUCKER,
      gespeichert: () => sichtbareBonierdrucker(),
    },
  ] as const

  describe.each(sichtbarkeiten.map(s => [s.name, s] as const))('POS-Konfiguration: sichtbare %s (PUT /api/kassen/:kasseId/pos-config)', (_name, s) => {
    it.each([
      ['fremde',          () => [s.fremde()]],
      ['unbekannte',      () => [s.unbekannte]],
      ['eigene und fremde', () => [s.eigene(), s.fremde()]],
    ])('%s ID → 404, nichts gespeichert (auch nicht der Rest der Anfrage)', async (_art, ids) => {
      const vorher         = await s.gespeichert()
      const proZeileVorher = await artikelProZeile()

      const res = await posConfig({ [s.feld]: ids(), artikelProZeile: proZeileVorher === 6 ? 5 : 6 })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ fehler: s.fehler })
      expect(await s.gespeichert()).toEqual(vorher)
      expect(await artikelProZeile()).toBe(proZeileVorher)
    })

    it('eigene ID → 204, gespeichert und per GET lesbar', async () => {
      const res = await posConfig({ [s.feld]: [s.eigene()] })
      expect(res.statusCode, res.body).toBe(204)
      expect(await s.gespeichert()).toEqual([s.eigene()])

      const get = await srv.fastify.inject({
        method: 'GET', url: `/api/kassen/${kasseA}/pos-config`, headers: authA(),
      })
      expect(get.json()[s.feld]).toEqual([s.eigene()])
    })

    it('dieselbe ID doppelt → 204 mit einer Zeile (statt Primärschlüssel-Verletzung)', async () => {
      const res = await posConfig({ [s.feld]: [s.eigene(), s.eigene()] })
      expect(res.statusCode, res.body).toBe(204)
      expect(await s.gespeichert()).toEqual([s.eigene()])
    })

    it('Altbestand mit fremder ID: GET liefert sie nicht, Zurückschicken klappt und räumt sie ab', async () => {
      expect((await posConfig({ [s.feld]: [s.eigene()] })).statusCode).toBe(204)
      // So konnte die fremde ID vor der Prüfung in die Tabelle kommen
      if (s.feld === 'sichtbareKategorieIds') {
        await idb.db.insert(kassekategorieSichtbarkeit).values({ kasseId: kasseA, kategorieId: kategorieB })
      } else {
        await idb.db.insert(kasseBonierdruckerSichtbarkeit).values({ kasseId: kasseA, bonierdruckerId: bonierdruckerB })
      }

      const get = await srv.fastify.inject({
        method: 'GET', url: `/api/kassen/${kasseA}/pos-config`, headers: authA(),
      })
      expect(get.statusCode).toBe(200)
      expect(get.json()[s.feld]).toEqual([s.eigene()])

      // Die Konfigurationsseiten schicken die geladene Liste beim Speichern zurück
      const res = await posConfig({ [s.feld]: get.json()[s.feld] })
      expect(res.statusCode, res.body).toBe(204)
      expect(await s.gespeichert()).toEqual([s.eigene()])
    })
  })
})
