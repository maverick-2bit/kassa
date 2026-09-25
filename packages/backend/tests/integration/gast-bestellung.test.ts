/**
 * Integrationstest: öffentliches Gast-Bestellsystem gegen echtes PostgreSQL.
 *
 *  GET  /api/gast/karte         — Speisekarte (ohne Auth)
 *  POST /api/gast/bestellung    — Bestellung ohne Zahlung -> Tab auf der Kasse (ohne Auth)
 *  POST /api/gast/checkout      — Bestellung mit Online-Zahlung (ohne Auth)
 *
 * Sicherheitsrelevant:
 *  - Preise kommen IMMER aus der DB, nie vom Client. Der Body akzeptiert nur
 *    artikelId+menge — der Tab-Betrag muss den DB-Preisen entsprechen.
 *  - Der Gast-Modus der Kasse (aus | tab | online) gilt für jede Route: bei „aus"
 *    nimmt die Kasse nichts an (die kasseId steht in jedem Tisch-QR), bei „online"
 *    lässt sich die Zahlung nicht über die Tab-Bestellung umgehen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { KasseEvent } from '@kassa/shared'
import { tischTabs } from '../../src/db/schema.js'
import { onKasseEvent } from '../../src/sse/event-bus.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@gast.at'
const ADMIN_PASSWORT = 'gast-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gast Test GmbH',
  uid:        'ATU99999904',
  kassenId:   'GAST-001',
  finanzOnline: { teilnehmerId: 'TID-GAST', benutzerkennung: 'BID-GAST', pin: 'PIN-GAST' },
  umgebung: 'test',
  admin: { name: 'Gast Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface TabPosition { artikelId: string; bezeichnung: string; preisBruttoCent: number; menge: number }
interface Tab { kellner: string; tischNummer: string; status: string; positionen: TabPosition[] }

describe('Gast-Bestellsystem (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let espressoId = ''   // 350 Cent
  let colaId     = ''   // 420 Cent

  // Kassen-Events (SSE) mitschreiben — eine abgewiesene Bestellung darf keinen Toast auslösen
  const kassenEvents: KasseEvent[] = []
  let eventsAbmelden: (() => void) | undefined

  const auth = () => ({ authorization: `Bearer ${token}` })

  const bestellung = (tischNummer: string, positionen: { artikelId: string; menge: number }[]) =>
    srv.fastify.inject({ method: 'POST', url: '/api/gast/bestellung', payload: { kasseId, tischNummer, positionen } })

  const checkout = (tischNummer: string, positionen: { artikelId: string; menge: number }[]) =>
    srv.fastify.inject({ method: 'POST', url: '/api/gast/checkout', payload: { kasseId, tischNummer, positionen } })

  /** Anzahl der Gast-Tabs dieser Kasse direkt aus der DB (unabhängig von API-Filtern) */
  const anzahlGastTabs = async () =>
    (await idb.db.select({ id: tischTabs.id }).from(tischTabs)
      .where(and(eq(tischTabs.kasseId, kasseId), eq(tischTabs.kellner, 'Gast')))).length

  const gastbestellungEvents = () => kassenEvents.filter(e => e.typ === 'neue_gastbestellung').length

  async function setzeGastModus(gastModus: string) {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(),
      payload: { gastModus },
    })
    if (res.statusCode !== 200 || res.json().gastModus !== gastModus) {
      throw new Error(`Gast-Modus „${gastModus}" nicht gesetzt (${res.statusCode}): ${res.body}`)
    }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id
    eventsAbmelden = onKasseEvent(login.mandant.id, e => { kassenEvents.push(e) })

    // Kategorie + zwei Artikel anlegen (authentifiziert)
    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'Getränke', farbe: 'blau', reihenfolge: 0 },
    })
    const katId = kat.json().id

    const a1 = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Espresso', preisBruttoCent: 350, mwstSatz: 'ermaessigt1', kategorieId: katId },
    })
    espressoId = a1.json().id
    const a2 = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung: 'Cola', preisBruttoCent: 420, mwstSatz: 'normal', kategorieId: katId },
    })
    colaId = a2.json().id
  })

  afterAll(async () => {
    eventsAbmelden?.()
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Gast-Modus „aus" — Standard jeder neuen Kasse ─────────────────────────────
  describe('Gast-Modus aus (Standard neuer Kassen)', () => {
    it('eine neue Kasse startet mit Gast-Modus „aus"', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/drucker`, headers: auth() })
      expect(res.statusCode).toBe(200)
      expect(res.json().gastModus).toBe('aus')
    })

    it('Speisekarte → 403', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })
      expect(res.statusCode).toBe(403)
    })

    it('Bestellung → 403, kein Tab, kein Toast an der Kasse', async () => {
      const tabsVorher   = await anzahlGastTabs()
      const eventsVorher = gastbestellungEvents()

      const res = await bestellung('Tisch 1', [{ artikelId: espressoId, menge: 1 }])
      expect(res.statusCode).toBe(403)

      expect(await anzahlGastTabs()).toBe(tabsVorher)
      expect(gastbestellungEvents()).toBe(eventsVorher)
    })

    it('Checkout → 403', async () => {
      const res = await checkout('T9', [{ artikelId: colaId, menge: 1 }])
      expect(res.statusCode).toBe(403)
    })

    it('Speisekarte: 400 ohne kasseId, 404 bei unbekannter Kasse', async () => {
      const ohne = await srv.fastify.inject({ method: 'GET', url: '/api/gast/karte' })
      expect(ohne.statusCode).toBe(400)
      const unbekannt = await srv.fastify.inject({
        method: 'GET', url: '/api/gast/karte?kasseId=11111111-1111-1111-1111-111111111111',
      })
      expect(unbekannt.statusCode).toBe(404)
    })

    it('ungültiger Gast-Modus → 400', async () => {
      const res = await srv.fastify.inject({
        method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(),
        payload: { gastModus: 'immer' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  // ── Gast-Modus „tab" — Bestellung ohne Zahlung landet als offener Tisch ──────
  describe('Gast-Modus tab (Bestellung ohne Zahlung)', () => {
    beforeAll(() => setzeGastModus('tab'))

    it('liefert die Speisekarte mit Kategorien, Artikeln und Gast-Modus (ohne Auth)', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })
      expect(res.statusCode).toBe(200)
      const karte = res.json()
      expect(karte.kasse.id).toBe(kasseId)
      expect(karte.gastModus).toBe('tab')
      expect(karte.kategorien.map((k: { name: string }) => k.name)).toContain('Getränke')
      const espresso = karte.artikel.find((a: { id: string }) => a.id === espressoId)
      expect(espresso).toBeDefined()
      expect(espresso.preisBruttoCent).toBe(350)
    })

    it('legt aus einer Bestellung einen Gast-Tab mit DB-Preisen an und meldet ihn der Kasse', async () => {
      const eventsVorher = gastbestellungEvents()
      const res = await bestellung('Tisch 7', [
        { artikelId: espressoId, menge: 2 },
        { artikelId: colaId,     menge: 1 },
      ])
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ erfolgreich: true })
      expect(gastbestellungEvents()).toBe(eventsVorher + 1)

      // Tab erscheint auf der Kasse
      const tabsRes = await srv.fastify.inject({
        method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
      })
      const tabs = tabsRes.json() as Tab[]
      const gastTab = tabs.find(t => t.kellner === 'Gast' && t.tischNummer === 'Tisch 7')
      expect(gastTab).toBeDefined()

      // Preise stammen aus der DB (2×350 + 1×420)
      const espressoPos = gastTab!.positionen.find(p => p.artikelId === espressoId)!
      expect(espressoPos.preisBruttoCent).toBe(350)
      expect(espressoPos.menge).toBe(2)
      const summe = gastTab!.positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
      expect(summe).toBe(2 * 350 + 420)
    })

    it('ignoriert einen vom Client mitgeschickten Fantasiepreis (Preise nur aus DB)', async () => {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/gast/bestellung',
        payload: {
          kasseId, tischNummer: 'Tisch 8',
          // preisBruttoCent: 1 wird vom Schema gar nicht akzeptiert/uebernommen
          positionen: [{ artikelId: espressoId, menge: 1, preisBruttoCent: 1 }],
        },
      })
      expect(res.statusCode).toBe(201)
      const tabsRes = await srv.fastify.inject({
        method: 'GET', url: `/api/tisch-tabs?kasseId=${kasseId}`, headers: auth(),
      })
      const tab = (tabsRes.json() as Tab[]).find(t => t.tischNummer === 'Tisch 8')!
      expect(tab.positionen[0]!.preisBruttoCent).toBe(350) // DB-Preis, nicht 1
    })

    it('weist ungültige Bestellungen ab', async () => {
      // unbekannte Kasse
      const fremdeKasse = await srv.fastify.inject({
        method: 'POST', url: '/api/gast/bestellung',
        payload: { kasseId: '11111111-1111-1111-1111-111111111111', tischNummer: 'T1', positionen: [{ artikelId: espressoId, menge: 1 }] },
      })
      expect(fremdeKasse.statusCode).toBe(404)

      // unbekannter Artikel
      const fremderArtikel = await bestellung('T1', [{ artikelId: '22222222-2222-2222-2222-222222222222', menge: 1 }])
      expect(fremderArtikel.statusCode).toBe(400)

      // leere Positionen
      const leer = await bestellung('T1', [])
      expect(leer.statusCode).toBe(400)

      // doppelte artikelId
      const doppelt = await bestellung('T1', [{ artikelId: espressoId, menge: 1 }, { artikelId: espressoId, menge: 2 }])
      expect(doppelt.statusCode).toBe(400)
    })

    it('Checkout → 403 (Online-Zahlung ist für die Kasse nicht aktiv)', async () => {
      const res = await checkout('T9', [{ artikelId: colaId, menge: 1 }])
      expect(res.statusCode).toBe(403)
    })
  })

  // ── Gast-Modus „online" — Checkout + Onlinezahlung (Demo-Pfad, kein Stripe) ──
  describe('Gast-Modus online (Bestellung mit Online-Zahlung)', () => {
    beforeAll(() => setzeGastModus('online'))

    it('Bestellung ohne Zahlung → 403, kein Tab, kein Toast (Zahlung nicht umgehbar)', async () => {
      const tabsVorher   = await anzahlGastTabs()
      const eventsVorher = gastbestellungEvents()

      const res = await bestellung('Terrasse 1', [{ artikelId: colaId, menge: 1 }])
      expect(res.statusCode).toBe(403)

      expect(await anzahlGastTabs()).toBe(tabsVorher)
      expect(gastbestellungEvents()).toBe(eventsVorher)
    })

    it('Speisekarte meldet den Bezahl-Modus', async () => {
      const karte = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })).json()
      expect(karte.gastModus).toBe('online')
    })

    it('Checkout: Demo-Pfad finalisiert sofort → RKSV-Beleg + Status bezahlt', async () => {
      // 2× Cola (420) = 840; ohne Stripe → Demo-Pfad finalisiert sofort (checkoutUrl = null)
      const res = await checkout('Terrasse 3', [{ artikelId: colaId, menge: 2 }])
      expect(res.statusCode).toBe(201)
      const { bestellungId, checkoutUrl } = res.json()
      expect(checkoutUrl).toBeNull()
      expect(bestellungId).toBeTruthy()

      const st = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/bestellung/${bestellungId}` })).json()
      expect(st.status).toBe('bezahlt')
      expect(st.summeCent).toBe(840)
      expect(st.belegId).toBeTruthy()
      expect(st.beleg?.beleg?.belegNummer).toBeGreaterThan(0)
      expect(st.beleg?.firmenname).toBe('Gast Test GmbH')
    })

    it('Checkout mit Trinkgeld: Beleg = Speisen + Trinkgeld, Trinkgeld als 0%-USt-Position', async () => {
      // 1× Cola (420) + 150 Cent Trinkgeld → Beleg-Gesamt 570, Trinkgeld im 0%-Topf
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/gast/checkout',
        payload: { kasseId, tischNummer: 'Terrasse 5', positionen: [{ artikelId: colaId, menge: 1 }], trinkgeldCent: 150 },
      })
      expect(res.statusCode).toBe(201)
      const { bestellungId, checkoutUrl } = res.json()
      expect(checkoutUrl).toBeNull()

      const st = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/bestellung/${bestellungId}` })).json()
      expect(st.status).toBe('bezahlt')

      const beleg = st.beleg.beleg
      expect(beleg.gesamtbetragCent).toBe(570)          // 420 Speisen + 150 Trinkgeld
      expect(beleg.betraege.null).toBe(150)             // Trinkgeld im 0%-USt-Topf
      const trinkgeldPos = beleg.positionen.find((p: { bezeichnung: string }) => p.bezeichnung === 'Trinkgeld')
      expect(trinkgeldPos).toBeDefined()
      expect(trinkgeldPos.mwstSatz).toBe('null')
      expect(trinkgeldPos.einzelpreisBreutto).toBe(150)
    })

    it('Checkout ohne Trinkgeld: kein 0%-Betrag, keine Trinkgeld-Position', async () => {
      const res = await checkout('Terrasse 6', [{ artikelId: colaId, menge: 1 }])
      expect(res.statusCode).toBe(201)
      const { bestellungId } = res.json()
      const st = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/bestellung/${bestellungId}` })).json()
      const beleg = st.beleg.beleg
      expect(beleg.gesamtbetragCent).toBe(420)
      expect(beleg.betraege.null).toBe(0)
      expect(beleg.positionen.some((p: { bezeichnung: string }) => p.bezeichnung === 'Trinkgeld')).toBe(false)
    })

    it('Checkout-Status einer unbekannten ID → 404', async () => {
      const res = await srv.fastify.inject({ method: 'GET', url: '/api/gast/bestellung/00000000-0000-0000-0000-000000000000' })
      expect(res.statusCode).toBe(404)
    })
  })
})
