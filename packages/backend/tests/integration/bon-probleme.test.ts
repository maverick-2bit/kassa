/**
 * Integrationstest: Bon-Probleme — das Bonierergebnis erreicht das Personal auch dort, wo der SERVER selbst boniert.
 *
 * Drei Wege warfen das Ergebnis weg (niemand wartet dort auf die Antwort):
 *   - Direktverkauf-Beleg mit Küchenartikeln (`bonierBeiDirektverkauf`, fire-and-forget NACH dem Beleg),
 *   - Gast-Bestellung (der Gast hat schon bezahlt),
 *   - SB-Terminal.
 * Ein toter Küchendrucker bzw. ein Bon am Backup-Drucker blieb dort völlig stumm. Jetzt merkt sich der Server eine
 * Meldung je Bestellung (GET /api/kassen/:id/bon-probleme), die bis „Verstanden“ bzw. bis „Nochmal senden“ alles
 * zugestellt hat stehen bleibt. „Nochmal senden“ geht mit der Bestell-ID des ersten Versuchs durch: Ziele, die den
 * Bon schon haben, bekommen ihn nicht noch einmal.
 *
 * Echte TCP-Listener stehen für die erreichbaren Drucker, Port 9 (ohne Listener) für die toten. Nur Anzeige: am
 * Druckverhalten ändert sich nichts — das prüft die Zählung der Bons an den Attrappen.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import net from 'node:net'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { BonProblem, KasseEvent } from '@kassa/shared'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { bonProbleme } from '../../src/db/schema.js'
import { onKasseEvent } from '../../src/sse/event-bus.js'
import { bonierUndMelde } from '../../src/services/bon-probleme.service.js'

const ADMIN_EMAIL = 'admin@bon-probleme.at', ADMIN_PASSWORT = 'bon-probleme-passwort-123'
const FREMD_EMAIL = 'admin@fremd-bon-probleme.at', FREMD_PASSWORT = 'fremd-bon-probleme-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BP-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

/** Der Keep-Alive-Ping des Backends (DLE EOT 1): druckt nichts, ist kein Bon. */
const KEEPALIVE_PING = Buffer.from([0x10, 0x04, 0x01])

/** TCP-Drucker-Attrappe: zählt die Verbindungen, die einen Bon brachten (= gedruckte Bons). */
interface Attrappe { server: net.Server; port: number; bons: () => number }
function druckerAttrappe(): Promise<Attrappe> {
  return new Promise(resolve => {
    let n = 0
    const server = net.createServer(socket => {
      const teile: Buffer[] = []
      socket.on('data', c => teile.push(c))
      socket.on('close', () => {
        const daten = Buffer.concat(teile)
        if (daten.length > 0 && !daten.equals(KEEPALIVE_PING)) n++
      })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, bons: () => n }))
  })
}
const kurzWarten = (ms = 300) => new Promise(r => setTimeout(r, ms))

describe('Bon-Probleme: Direktverkauf-Beleg, Gast- und SB-Bestellung (Integration, echtes PostgreSQL + TCP-Listener)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', tokenFremd = '', kasseId = '', kasse2Id = '', kasseFremdId = '', mandantId = ''
  let schank: Attrappe, ersatz: Attrappe
  const drucker = { schank: '', ersatz: '', kueche: '', grill: '' }
  const art = { cola: '', steak: '', fisch: '', gastSteak: '', sbSteak: '' }
  const events: KasseEvent[] = []
  let eventsAbmelden: (() => void) | undefined

  const auth = (t = token) => ({ authorization: `Bearer ${t}` })
  const post = async (url: string, payload: unknown, t = token) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(t), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const liste = async (k = kasseId, t = token): Promise<BonProblem[]> => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${k}/bon-probleme`, headers: auth(t) })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as BonProblem[]
  }
  const nochmal = (id: string, t = token) =>
    srv.fastify.inject({ method: 'POST', url: `/api/bon-probleme/${id}/nochmal`, headers: auth(t) })
  const verstanden = (id: string, t = token) =>
    srv.fastify.inject({ method: 'POST', url: `/api/bon-probleme/${id}/verstanden`, headers: auth(t) })
  const setzeDrucker = async (id: string, payload: Record<string, unknown>) => {
    const res = await srv.fastify.inject({ method: 'PATCH', url: `/api/bonierdrucker/${id}`, headers: auth(), payload })
    expect(res.statusCode, res.body).toBe(200)
  }
  /** Direktverkauf-Beleg mit den Artikeln (Barzahlung); der Bon läuft fire-and-forget hinterher */
  const direktverkauf = async (artikelIds: string[]) => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
      payload: {
        kasseId,
        positionen: artikelIds.map(artikelId => ({ artikelId, menge: 1, einzelpreisBreuttoCent: 500 })),
        zahlung: { barCent: 500 * artikelIds.length, karteCent: 0, sonstigeCent: 0 },
      },
    })
    expect(res.statusCode, res.body).toBe(201)
  }
  const meldungenFuer = (k: string) => events.filter(e => e.typ === 'bon_probleme' && e.kasseId === k).length

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    schank = await druckerAttrappe()
    ersatz = await druckerAttrappe()

    const setup = async (suffix: string, uid: string, email: string, passwort: string) => {
      const r = await srv.fastify.inject({
        method: 'POST', url: '/api/setup',
        payload: {
          firmenname: `BonProbleme ${suffix} GmbH`, uid, kassenId: `BP-${suffix}`,
          finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
          admin: { name: `BP Admin ${suffix}`, email, passwort },
        },
      })
      if (r.statusCode !== 201) throw new Error(`Setup ${suffix}: ${r.body}`)
      const login = (await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, passwort } })).json()
      return login as { token: string; kassen: { id: string }[]; mandant: { id: string } }
    }
    const a = await setup('A', 'ATU99999921', ADMIN_EMAIL, ADMIN_PASSWORT)
    token = a.token; kasseId = a.kassen[0]!.id; mandantId = a.mandant.id
    const b = await setup('B', 'ATU99999922', FREMD_EMAIL, FREMD_PASSWORT)
    tokenFremd = b.token; kasseFremdId = b.kassen[0]!.id
    eventsAbmelden = onKasseEvent(mandantId, e => { events.push(e) })

    // Eine zweite Kasse desselben Mandanten: ihre Liste muss leer bleiben
    kasse2Id = ((await srv.fastify.inject({
      method: 'POST', url: '/api/kassen', headers: auth(),
      payload: { kassenId: 'BP-A2', bezeichnung: 'Zweite Kasse', umgebung: 'test' },
    })).json() as { kasseId: string }).kasseId

    // Schank- und Ersatzdrucker sind erreichbar; Küche und Grill nicht (Port 9 hat keinen Listener).
    // Der Grill hat von Anfang an einen Backup-Drucker (Ersatz), die Küche zunächst keinen.
    drucker.schank = (await post('/api/bonierdrucker', { name: 'Schankdrucker', ip: '127.0.0.1', port: schank.port })).id
    drucker.ersatz = (await post('/api/bonierdrucker', { name: 'Ersatzdrucker', ip: '127.0.0.1', port: ersatz.port })).id
    drucker.kueche = (await post('/api/bonierdrucker', { name: 'Küchendrucker', ip: '127.0.0.1', port: 9 })).id
    drucker.grill  = (await post('/api/bonierdrucker', { name: 'Grilldrucker', ip: '127.0.0.1', port: 9, fallbackId: drucker.ersatz })).id

    const artikel = (bezeichnung: string, bonierdruckerId: string, extra: Record<string, unknown> = {}) => post('/api/artikel', {
      bezeichnung, preisBruttoCent: 500, mwstSatz: 'normal', bonierdruckerId, ...extra,
    }).then(r => r.id)
    art.cola      = await artikel('Cola', drucker.schank, { bonierBeiDirektverkauf: true })
    art.steak     = await artikel('Steak', drucker.kueche, { bonierBeiDirektverkauf: true })
    art.fisch     = await artikel('Fisch', drucker.grill, { bonierBeiDirektverkauf: true })
    art.gastSteak = await artikel('Gast-Steak', drucker.kueche)
    art.sbSteak   = await artikel('SB-Steak', drucker.kueche, { terminalSichtbar: true })
  })

  afterAll(async () => {
    eventsAbmelden?.()
    schank?.server.close(); ersatz?.server.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ===========================================================================================================
  // Direktverkauf-Beleg
  // ===========================================================================================================
  describe('Direktverkauf-Beleg', () => {
    let offen: BonProblem

    it('Gegenprobe — erreichbarer Drucker: der Bon kommt an, es entsteht keine Meldung', async () => {
      await direktverkauf([art.cola])
      await vi.waitFor(() => expect(schank.bons()).toBe(1))
      await kurzWarten()
      expect(await liste()).toEqual([])
      expect(meldungenFuer(kasseId)).toBe(0)
    })

    it('toter Küchendrucker: Meldung „Bon NICHT angekommen“ mit genau diesem Ziel — der erreichbare Drucker bekommt seinen Bon', async () => {
      const vorher = schank.bons()
      await direktverkauf([art.cola, art.steak])
      await vi.waitFor(async () => expect(await liste()).toHaveLength(1))
      const m = await liste()
      offen = m[0]!
      expect(offen.quelle).toBe('direktverkauf')
      expect(offen.titel).toBe('Direktverkauf')
      expect(offen.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])
      expect(offen.umleitungen).toEqual([])
      expect(schank.bons()).toBe(vorher + 1)            // Anzeige ändert nichts am Druck
      expect(meldungenFuer(kasseId)).toBe(1)            // die Kasse bekommt den Anstoß zum Neuladen
    })

    it('die Meldung betrifft nur diese Kasse: die zweite Kasse desselben Mandanten sieht nichts', async () => {
      expect(await liste(kasse2Id)).toEqual([])
      expect(meldungenFuer(kasse2Id)).toBe(0)
    })

    it('Nochmal senden bei weiter totem Ziel: Meldung bleibt, nichts wird doppelt gedruckt', async () => {
      const vorher = schank.bons()
      const res = await nochmal(offen.id)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().problem.fehler.map((f: { ziel: string }) => f.ziel)).toEqual(['Küchendrucker'])
      await kurzWarten()
      expect(schank.bons()).toBe(vorher)                // die Cola liegt schon am Schankdrucker
      expect(await liste()).toHaveLength(1)
    })

    it('Backup-Drucker eingetragen → Nochmal senden: aus Rot wird der bernsteinfarbene Hinweis; der Schankdrucker druckt NICHT noch einmal', async () => {
      const vorherSchank = schank.bons(), vorherErsatz = ersatz.bons()
      await setzeDrucker(drucker.kueche, { fallbackId: drucker.ersatz })
      const res = await nochmal(offen.id)
      expect(res.statusCode, res.body).toBe(200)
      const p = res.json().problem as BonProblem
      expect(p.fehler).toEqual([])
      expect(p.umleitungen.map(u => u.hinweis)).toEqual(['Küchendrucker nicht erreichbar — Bon kam an Ersatzdrucker. Bitte weitergeben.'])
      await vi.waitFor(() => expect(ersatz.bons()).toBe(vorherErsatz + 1))
      await kurzWarten()
      expect(schank.bons()).toBe(vorherSchank)
      expect((await liste())[0]!.umleitungen).toHaveLength(1)
    })

    it('Verstanden: die Meldung verschwindet (wiederholbar, auch ohne weitere Meldung)', async () => {
      expect((await verstanden(offen.id)).statusCode).toBe(204)
      expect(await liste()).toEqual([])
      expect((await verstanden(offen.id)).statusCode).toBe(204)
      expect((await nochmal(offen.id)).json().problem).toBeNull()   // erledigt: nichts mehr zu senden
    })

    it('Backup-Drucker springt von Anfang an ein: nur der Hinweis, keine rote Meldung', async () => {
      const vorher = ersatz.bons()
      await direktverkauf([art.fisch])
      await vi.waitFor(async () => expect(await liste()).toHaveLength(1))
      const p = (await liste())[0]!
      expect(p.fehler).toEqual([])
      expect(p.umleitungen.map(u => u.hinweis)).toEqual(['Grilldrucker nicht erreichbar — Bon kam an Ersatzdrucker. Bitte weitergeben.'])
      expect(ersatz.bons()).toBe(vorher + 1)
      await verstanden(p.id)
    })

    it('Nochmal senden, wenn das Ziel inzwischen erreichbar ist: die Meldung ist erledigt', async () => {
      // Küche ist wieder da: der Port zeigt jetzt auf einen Listener, der Backup-Drucker ist entfernt
      await setzeDrucker(drucker.kueche, { fallbackId: null, port: 9 })
      await direktverkauf([art.steak])
      await vi.waitFor(async () => expect(await liste()).toHaveLength(1))
      const p = (await liste())[0]!
      expect(p.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])

      const vorher = ersatz.bons()
      await setzeDrucker(drucker.kueche, { port: ersatz.port })
      const res = await nochmal(p.id)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().problem).toBeNull()
      expect(ersatz.bons()).toBe(vorher + 1)             // genau ein Bon — und nur für das Ziel, das fehlte
      expect(await liste()).toEqual([])
      await setzeDrucker(drucker.kueche, { port: 9 })    // wieder tot für die folgenden Tests
    })
  })

  // ===========================================================================================================
  // Gast-Bestellung
  // ===========================================================================================================
  describe('Gast-Bestellung (bezahlt, danach boniert)', () => {
    it('toter Küchendrucker: Meldung mit Tisch — der Gast hat schon bezahlt', async () => {
      const modus = await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(), payload: { gastModus: 'online' } })
      expect(modus.statusCode, modus.body).toBe(200)
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/gast/checkout',
        payload: { kasseId, tischNummer: 'T7', positionen: [{ artikelId: art.gastSteak, menge: 1 }] },
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().checkoutUrl).toBeNull()          // Demo-Pfad: sofort bezahlt und boniert

      const m = (await liste()).filter(p => p.quelle === 'gast')
      expect(m).toHaveLength(1)
      expect(m[0]!.titel).toBe('Gast-Bestellung · Tisch T7')
      expect(m[0]!.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])
    })

    it('Nochmal senden mit Backup-Drucker: Hinweis; Verstanden räumt auf', async () => {
      const p = (await liste()).find(x => x.quelle === 'gast')!
      const vorher = ersatz.bons()
      await setzeDrucker(drucker.kueche, { fallbackId: drucker.ersatz })
      const res = await nochmal(p.id)
      expect(res.statusCode, res.body).toBe(200)
      const neu = res.json().problem as BonProblem
      expect(neu.fehler).toEqual([])
      expect(neu.umleitungen).toHaveLength(1)
      expect(ersatz.bons()).toBe(vorher + 1)
      await verstanden(p.id)
      expect((await liste()).filter(x => x.quelle === 'gast')).toEqual([])
      await setzeDrucker(drucker.kueche, { fallbackId: null })
    })
  })

  // ===========================================================================================================
  // SB-Terminal
  // ===========================================================================================================
  describe('SB-Terminal', () => {
    it('toter Küchendrucker: Meldung mit der SB-Nummer', async () => {
      const modul = await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSbTerminalAktiv: true } })
      expect(modul.statusCode, modul.body).toBe(200)
      const anlage = await srv.fastify.inject({
        method: 'POST', url: '/api/terminal/bestellung',
        payload: { kasseId, positionen: [{ artikelId: art.sbSteak, menge: 1 }] },
      })
      expect(anlage.statusCode, anlage.body).toBe(201)
      const bestaetigt = await srv.fastify.inject({ method: 'POST', url: `/api/terminal/bestellung/${anlage.json().id}/bestaetigen` })
      expect(bestaetigt.statusCode, bestaetigt.body).toBe(200)

      const m = (await liste()).filter(p => p.quelle === 'sb')
      expect(m).toHaveLength(1)
      expect(m[0]!.titel).toMatch(/^SB-Bestellung · SB \d+$/)
      expect(m[0]!.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])
      await verstanden(m[0]!.id)
    })
  })

  // ===========================================================================================================
  // Mandanten- und Kassen-Grenzen, Robustheit
  // ===========================================================================================================
  describe('Grenzen', () => {
    let fremdesProblem: BonProblem

    it('ein anderer Mandant sieht die Kasse und ihre Meldungen nicht (404), und kann sie weder senden noch bestätigen', async () => {
      await direktverkauf([art.steak])
      await vi.waitFor(async () => expect(await liste()).toHaveLength(1))
      fremdesProblem = (await liste())[0]!

      const res = await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/bon-probleme`, headers: auth(tokenFremd) })
      expect(res.statusCode).toBe(404)
      expect((await nochmal(fremdesProblem.id, tokenFremd)).statusCode).toBe(404)
      expect((await verstanden(fremdesProblem.id, tokenFremd)).statusCode).toBe(404)
      expect(await liste(kasseFremdId, tokenFremd)).toEqual([])
      // … und die Meldung ist unberührt
      expect(await liste()).toHaveLength(1)
      expect((await idb.db.select().from(bonProbleme).where(eq(bonProbleme.id, fremdesProblem.id)))[0]!.erledigtAt).toBeNull()
    })

    it('die Liste ist an den Mandanten gebunden, auch wenn eine fremde Kasse-ID verwendet wird', async () => {
      // Ein Benutzer des fremden Mandanten fragt mit der eigenen Kasse — und bekommt nur eigene Zeilen
      expect(await liste(kasseFremdId, tokenFremd)).toEqual([])
    })

    it('ungültige IDs → 400', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: '/api/kassen/keine-uuid/bon-probleme', headers: auth() })).statusCode).toBe(400)
      expect((await nochmal('keine-uuid')).statusCode).toBe(400)
      expect((await verstanden('keine-uuid')).statusCode).toBe(400)
    })

    it('ohne Anmeldung → 401', async () => {
      expect((await srv.fastify.inject({ method: 'GET', url: `/api/kassen/${kasseId}/bon-probleme` })).statusCode).toBe(401)
    })

    it('bonierUndMelde wirft nie: auch wenn die Bonierung selbst scheitert (unbekannte Kasse), kommt keine Ausnahme heraus', async () => {
      const fehler = vi.fn()
      await expect(bonierUndMelde(
        idb.db,
        { kasseId: '99999999-9999-4999-8999-999999999999', tisch: 'X', kellner: 'Gast', positionen: [{ artikelId: art.cola, menge: 1 }] },
        { quelle: 'gast', mandantId },
        { error: fehler },
      )).resolves.toBeUndefined()
      expect(fehler).toHaveBeenCalled()
      expect(await liste()).toHaveLength(1)              // keine zusätzliche Meldung ohne Kasse
    })
  })
})
