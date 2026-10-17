/**
 * Integrationstest: Gang abrufen und Position nachschicken melden dem Personal, wo der Bon liegt.
 *
 * Beide Vorgänge boniert der SERVER für den Kellner — die Oberfläche sah das Bonierergebnis nie. Ein ganz
 * gescheiterter Gang-Abruf blieb stumm (die Positionen stehen schon als gesendet), ein Bon am Backup-Drucker
 * ebenso. Jetzt trägt die Antwort `bon` — aber NUR, wenn es etwas zu melden gibt:
 *   - `fehler`      → rote Leiste „Bon NICHT angekommen“
 *   - `umleitungen` → bernsteinfarbener Hinweis (Bon liegt am Backup-Drucker)
 *   - `nachsenden`  → die Bonierung für „Nochmal senden“, MIT Bestell-ID: der Server bedient dann nur noch
 *                     die Ziele, die den Bon nicht haben — nichts wird doppelt gedruckt.
 *
 * Echte TCP-Listener stehen für die erreichbaren Drucker, Port 9 (ohne Listener) für die toten.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { BonRueckmeldung, TabPosition } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { artikel as artikelTabelle, bonierBestellungen } from '../../src/db/schema.js'

const ADMIN_EMAIL = 'admin@bon-rueckmeldung.at', ADMIN_PASSWORT = 'bon-rueckmeldung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BR-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

/** TCP-Drucker-Attrappe: hält jeden angekommenen Bon als Text fest (eine Verbindung = ein Bon). */
interface Attrappe { server: net.Server; port: number; bons: string[] }
function druckerAttrappe(): Promise<Attrappe> {
  return new Promise(resolve => {
    const bons: string[] = []
    const server = net.createServer(socket => {
      const teile: Buffer[] = []
      socket.on('data', c => teile.push(c))
      socket.on('close', () => { if (teile.length > 0) bons.push(Buffer.concat(teile).toString('latin1')) })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, bons }))
  })
}
const kurzWarten = () => new Promise(r => setTimeout(r, 200))

describe('Gang abrufen / nachschicken: Rückmeldung zum Bon (Integration, echtes PostgreSQL + TCP-Listener)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  let schank: Attrappe, ersatz: Attrappe
  const drucker = { schank: '', ersatz: '', kueche: '', grill: '' }
  const art = { suppe: '', steak: '', fisch: '', brot: '' }

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  /** Backup-Drucker eintragen bzw. entfernen — als hätte der Chef das Problem inzwischen behoben. */
  const setzeBackup = async (druckerId: string, fallbackId: string | null) => {
    const res = await srv.fastify.inject({ method: 'PATCH', url: `/api/bonierdrucker/${druckerId}`, headers: auth(), payload: { fallbackId } })
    expect(res.statusCode, res.body).toBe(200)
  }

  let tischZaehler = 0
  /** Offener Tisch mit Positionen; `gang` je Position (0 = Sofort) */
  const legeTabAn = async (positionen: Array<{ artikelId: string; bezeichnung: string; gang: number; menge?: number }>) => {
    const tisch = `T${++tischZaehler}`
    const tab = (await srv.fastify.inject({
      method: 'POST', url: '/api/tisch-tabs', headers: auth(),
      payload: { kasseId, tischNummer: tisch, kellner: 'Anna' },
    })).json() as { id: string }
    const put = await srv.fastify.inject({
      method: 'PUT', url: `/api/tisch-tabs/${tab.id}/positionen`, headers: auth(),
      payload: { positionen: positionen.map(p => ({ artikelId: p.artikelId, bezeichnung: p.bezeichnung, preisBruttoCent: 500, menge: p.menge ?? 1, gang: p.gang })) },
    })
    expect(put.statusCode, put.body).toBe(200)
    return { id: tab.id, tisch }
  }
  const holePositionen = async (tabId: string): Promise<TabPosition[]> =>
    (await srv.fastify.inject({ method: 'GET', url: `/api/tisch-tabs/${tabId}`, headers: auth() })).json().positionen
  const gangAbrufen = (tabId: string) =>
    srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/gang-abrufen`, headers: auth() })
  const nachschicken = (tabId: string, positionIndex: number) =>
    srv.fastify.inject({ method: 'POST', url: `/api/tisch-tabs/${tabId}/position-nachschicken`, headers: auth(), payload: { positionIndex } })
  /** „Nochmal senden“ der Oberfläche: die Rückmeldung unverändert an die Bonier-Route */
  const sendeNochmal = (bon: BonRueckmeldung) =>
    srv.fastify.inject({ method: 'POST', url: '/api/bestellung/bonieren', headers: auth(), payload: bon.nachsenden as object })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    schank = await druckerAttrappe()
    ersatz = await druckerAttrappe()

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'BonRueckmeldung GmbH', uid: 'ATU99999917', kassenId: 'BR-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'BR Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup: ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Schankdrucker und Ersatzdrucker sind erreichbar; Küche und Grill nicht (Port 9 hat keinen Listener).
    // Der Grill hat von Anfang an einen Backup-Drucker (Ersatz), die Küche zunächst keinen.
    drucker.schank = (await post('/api/bonierdrucker', { name: 'Schankdrucker', ip: '127.0.0.1', port: schank.port })).id
    drucker.ersatz = (await post('/api/bonierdrucker', { name: 'Ersatzdrucker', ip: '127.0.0.1', port: ersatz.port })).id
    drucker.kueche = (await post('/api/bonierdrucker', { name: 'Küchendrucker', ip: '127.0.0.1', port: 9 })).id
    drucker.grill  = (await post('/api/bonierdrucker', { name: 'Grilldrucker', ip: '127.0.0.1', port: 9, fallbackId: drucker.ersatz })).id

    const artikel = (bezeichnung: string, bonierdruckerId?: string) => post('/api/artikel', {
      bezeichnung, preisBruttoCent: 500, mwstSatz: 'normal', ...(bonierdruckerId ? { bonierdruckerId } : {}),
    }).then(r => r.id)
    art.suppe = await artikel('Suppe', drucker.schank)
    art.steak = await artikel('Steak', drucker.kueche)
    art.fisch = await artikel('Fisch', drucker.grill)
    art.brot  = await artikel('Brot')          // ohne Station und Drucker: für ihn gibt es nichts zu bonieren
  })

  afterAll(async () => {
    schank?.server.close(); ersatz?.server.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ===========================================================================================================
  // Gang abrufen
  // ===========================================================================================================
  describe('Gang abrufen', () => {
    it('Ziel nicht erreichbar: die Antwort meldet es samt Nachsende-Bonierung — die Positionen bleiben gesendet', async () => {
      const tab = await legeTabAn([
        { artikelId: art.suppe, bezeichnung: 'Suppe', gang: 1 },
        { artikelId: art.steak, bezeichnung: 'Steak', gang: 1 },
      ])
      const vorher = schank.bons.length

      const res = await gangAbrufen(tab.id)
      expect(res.statusCode).toBe(200)                       // der Abruf selbst gelang, nur ein Ziel blieb stumm
      expect(res.json().gang).toBe(1)

      const bon = res.json().bon as BonRueckmeldung
      expect(bon.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])    // Suppe kam am Schankdrucker an, Steak nicht
      expect(bon.fehler[0]!.fehler).toBeTruthy()
      expect(bon.umleitungen).toEqual([])
      // Die Bonierung zum Nachsenden: derselbe Bon (Tisch-Label mit Gang, beide Positionen) mit EINER festen Bestell-ID
      expect(bon.nachsenden).toMatchObject({
        kasseId, tabId: tab.id, tisch: `${tab.tisch} · 1. Gang`, kellner: 'Anna', ohneLagerabzug: true,
        positionen: [{ artikelId: art.suppe, menge: 1, gang: 1 }, { artikelId: art.steak, menge: 1, gang: 1 }],
      })
      expect(bon.nachsenden.bestellId).toMatch(/^[0-9a-f-]{36}$/)
      expect(bon.nachsenden.storno).toBeUndefined()

      // Wie beim Parken: gebucht ist gebucht — der Gang bleibt gesendet, die Rückmeldung sagt, dass der Bon fehlt
      expect((await holePositionen(tab.id)).every(p => !!p.gesendetAm)).toBe(true)
      await vi.waitFor(() => expect(schank.bons).toHaveLength(vorher + 1))
      expect(schank.bons[vorher]).toContain('1x Suppe')
    })

    it('„Nochmal senden“ mit der Bestell-ID: nur das Ziel, das den Bon nicht hat, bekommt ihn — nichts doppelt', async () => {
      const tab = await legeTabAn([
        { artikelId: art.suppe, bezeichnung: 'Suppe', gang: 1 },
        { artikelId: art.steak, bezeichnung: 'Steak', gang: 1 },
      ])
      const schankDavor = schank.bons.length
      const bon = (await gangAbrufen(tab.id)).json().bon as BonRueckmeldung
      await vi.waitFor(() => expect(schank.bons).toHaveLength(schankDavor + 1))     // die Suppe ist angekommen
      await kurzWarten()
      const schankVorher = schank.bons.length, ersatzVorher = ersatz.bons.length

      // Solange die Küche tot bleibt, scheitert auch das Nachsenden — und ruft den Schankdrucker NICHT noch einmal an
      const nochmalTot = await sendeNochmal(bon)
      expect(nochmalTot.statusCode).toBe(207)
      await kurzWarten()
      expect(schank.bons).toHaveLength(schankVorher)
      expect(ersatz.bons).toHaveLength(ersatzVorher)

      // Backup-Drucker eingetragen: jetzt kommt der Steak-Bon am Ersatzdrucker an — der Schankdrucker bleibt unberührt
      await setzeBackup(drucker.kueche, drucker.ersatz)
      try {
        const nochmal = await sendeNochmal(bon)
        expect(nochmal.statusCode).toBe(200)
        const ergebnis = nochmal.json()
        expect(ergebnis.drucker.find((d: { name: string }) => d.name.startsWith('Küchendrucker'))).toMatchObject({
          erfolgreich: true, umleitung: { von: 'Küchendrucker', an: 'Ersatzdrucker' },
        })
        await vi.waitFor(() => expect(ersatz.bons).toHaveLength(ersatzVorher + 1))
        expect(ersatz.bons[ersatzVorher]).toContain('1x Steak')
        expect(ersatz.bons[ersatzVorher]).toContain('1. Gang')       // das Tisch-Label mit dem Gang kommt mit
        await kurzWarten()
        expect(schank.bons).toHaveLength(schankVorher)               // die Suppe wurde NICHT noch einmal gedruckt

        // und ein weiteres „Nochmal senden“ druckt gar nichts mehr
        expect((await sendeNochmal(bon)).statusCode).toBe(200)
        await kurzWarten()
        expect(ersatz.bons).toHaveLength(ersatzVorher + 1)
        expect(schank.bons).toHaveLength(schankVorher)
      } finally {
        await setzeBackup(drucker.kueche, null)
      }
    })

    it('Bon am Backup-Drucker: kein Fehlschlag, aber der Hinweis in `umleitungen`', async () => {
      const tab = await legeTabAn([{ artikelId: art.fisch, bezeichnung: 'Fisch', gang: 2 }])
      const ersatzVorher = ersatz.bons.length

      const res = await gangAbrufen(tab.id)
      expect(res.statusCode).toBe(200)
      const bon = res.json().bon as BonRueckmeldung
      expect(bon.fehler).toEqual([])
      expect(bon.umleitungen).toEqual([{
        von: 'Grilldrucker', an: 'Ersatzdrucker', ip: '127.0.0.1',
        hinweis: 'Grilldrucker nicht erreichbar — Bon kam an Ersatzdrucker. Bitte weitergeben.',
      }])
      await vi.waitFor(() => expect(ersatz.bons).toHaveLength(ersatzVorher + 1))
      expect(ersatz.bons[ersatzVorher]).toContain('1x Fisch')
    })

    it('alles am vorgesehenen Gerät angekommen: die Antwort bleibt wie bisher (kein `bon`)', async () => {
      const tab = await legeTabAn([{ artikelId: art.suppe, bezeichnung: 'Suppe', gang: 1 }])
      const res = await gangAbrufen(tab.id)
      expect(res.statusCode).toBe(200)
      expect(Object.keys(res.json()).sort()).toEqual(['gang', 'tab'])
    })

    it('Artikel ohne Station und Drucker: nichts zu bonieren → kein `bon`, der Gang gilt als gesendet', async () => {
      const tab = await legeTabAn([{ artikelId: art.brot, bezeichnung: 'Brot', gang: 1 }])
      const res = await gangAbrufen(tab.id)
      expect(res.statusCode).toBe(200)
      expect(res.json().bon).toBeUndefined()
      expect((await holePositionen(tab.id))[0]!.gesendetAm).toBeTruthy()
      // die Bestell-ID wurde wieder freigegeben (nichts zu bonieren hinterlässt keinen Eintrag)
      expect(await idb.db.select().from(bonierBestellungen).where(eq(bonierBestellungen.kasseId, kasseId))
        .then(rows => rows.filter(r => r.ergebnis === null))).toEqual([])
    })

    it('Bonieren wirft (Artikel inzwischen deaktiviert): die Markierung wird zurückgenommen — wie bisher', async () => {
      const tab = await legeTabAn([{ artikelId: art.suppe, bezeichnung: 'Suppe', gang: 1 }])
      await idb.db.update(artikelTabelle).set({ aktiv: false }).where(eq(artikelTabelle.id, art.suppe))
      try {
        const res = await gangAbrufen(tab.id)
        expect(res.statusCode).toBeGreaterThanOrEqual(400)
        expect((await holePositionen(tab.id))[0]!.gesendetAm ?? null).toBeNull()   // der Gang bleibt abrufbar
      } finally {
        await idb.db.update(artikelTabelle).set({ aktiv: true }).where(eq(artikelTabelle.id, art.suppe))
      }
    })
  })

  // ===========================================================================================================
  // Position nachschicken
  // ===========================================================================================================
  describe('Position nachschicken', () => {
    it('erreichbares Ziel: 204 wie bisher', async () => {
      const tab = await legeTabAn([{ artikelId: art.suppe, bezeichnung: 'Suppe', gang: 1 }])
      const res = await nachschicken(tab.id, 0)
      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
    })

    it('Ziel nicht erreichbar: 200 mit der Rückmeldung; „Nochmal senden“ geht mit derselben Bestell-ID durch', async () => {
      const tab = await legeTabAn([{ artikelId: art.steak, bezeichnung: 'Steak', gang: 2 }])
      const res = await nachschicken(tab.id, 0)
      expect(res.statusCode).toBe(200)
      const bon = res.json().bon as BonRueckmeldung
      expect(bon.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])
      expect(bon.umleitungen).toEqual([])
      expect(bon.nachsenden).toMatchObject({
        kasseId, tabId: tab.id, tisch: `${tab.tisch} · 2. Gang ↻`, positionen: [{ artikelId: art.steak, menge: 1, gang: 2 }],
      })
      expect(bon.nachsenden.bestellId).toBeTruthy()

      const ersatzVorher = ersatz.bons.length
      await setzeBackup(drucker.kueche, drucker.ersatz)
      try {
        const nochmal = await sendeNochmal(bon)
        expect(nochmal.statusCode).toBe(200)
        await vi.waitFor(() => expect(ersatz.bons).toHaveLength(ersatzVorher + 1))
        expect(ersatz.bons[ersatzVorher]).toContain('1x Steak')
      } finally {
        await setzeBackup(drucker.kueche, null)
      }
    })

    it('jeder Klick auf ↻ ist ein eigener Ausdruck: neue Bestell-ID, auch bei derselben Position', async () => {
      const tab = await legeTabAn([{ artikelId: art.steak, bezeichnung: 'Steak', gang: 0 }])
      const eins = (await nachschicken(tab.id, 0)).json().bon as BonRueckmeldung
      const zwei = (await nachschicken(tab.id, 0)).json().bon as BonRueckmeldung
      expect(eins.nachsenden.bestellId).not.toBe(zwei.nachsenden.bestellId)
    })

    it('Bon am Backup-Drucker: 200 mit `umleitungen`, ohne Fehlschlag', async () => {
      const tab = await legeTabAn([{ artikelId: art.fisch, bezeichnung: 'Fisch', gang: 0 }])
      const ersatzVorher = ersatz.bons.length
      const res = await nachschicken(tab.id, 0)
      expect(res.statusCode).toBe(200)
      const bon = res.json().bon as BonRueckmeldung
      expect(bon.fehler).toEqual([])
      expect(bon.umleitungen.map(u => u.hinweis)).toEqual([
        'Grilldrucker nicht erreichbar — Bon kam an Ersatzdrucker. Bitte weitergeben.',
      ])
      await vi.waitFor(() => expect(ersatz.bons).toHaveLength(ersatzVorher + 1))
    })

    it('Artikel ohne Station und Drucker: nichts zu bonieren → 204', async () => {
      const tab = await legeTabAn([{ artikelId: art.brot, bezeichnung: 'Brot', gang: 0 }])
      expect((await nachschicken(tab.id, 0)).statusCode).toBe(204)
    })

    it('ungültiger Index → 404 wie bisher', async () => {
      const tab = await legeTabAn([{ artikelId: art.suppe, bezeichnung: 'Suppe', gang: 0 }])
      expect((await nachschicken(tab.id, 99)).statusCode).toBe(404)
    })
  })
})
