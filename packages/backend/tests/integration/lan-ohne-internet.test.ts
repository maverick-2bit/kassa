/**
 * Integrationstest: Kassa im lokalen Netz OHNE Internet (z. B. Unifi-Gateway, WAN weg, alle Geräte
 * mit fixen IPs) — echtes PostgreSQL, echte TCP-Verbindungen zu nachgebauten LAN-Geräten.
 *
 * Simuliert wird das Internet, nicht das LAN: Jeder fetch des Backends, der NICHT ins lokale Netz
 * geht (A-Trust, FinanzOnline, GitHub-Versionsprüfung …), scheitert — wahlweise sofort (DNS findet
 * nichts) oder er hängt, bis das Zeitlimit des Aufrufers greift (der schlimmste Fall: WLAN/DNS
 * antwortet nicht). Der Mailserver ist ein TCP-Port, der annimmt und nie antwortet. Drucker und
 * KDS-Geräte sind TCP-Listener auf festen Loopback-IPs (127.0.0.10 …), wie Geräte mit fixer IP.
 *
 * Geprüft wird, dass alles, was im Betrieb vor Ort zählt, weiterläuft — und wie lange es dauert:
 *  - Bestellsystem ohne Beleg: Bonieren → Bonierdrucker (Schank/Küche) bzw. KDS-Geräte
 *  - Verkauf mit lokal signierender Signatureinheit → signierter Beleg + Bon am Bondrucker
 *  - Verkauf mit A-Trust (online) → Ausfallmodus nach dem Zeitlimit, danach ohne Wartezeit
 *  - Z-Bon mit hängendem Mailserver → wird sofort gedruckt
 *  - Update-Prüfung ohne Internet hält nicht jede Statusabfrage auf
 *  - kein Internet-Aufruf ohne Zeitlimit (er hinge sonst ewig)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { istAusfallBeleg, type FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { encryptPrivateKey } from '../../src/crypto/master-key.js'
import { kassen } from '../../src/db/schema.js'

const ADMIN_EMAIL    = 'admin@lan-offline.at'
const ADMIN_PASSWORT = 'lan-offline-passwort-123'

// ── Internet weg ────────────────────────────────────────────────────────────

type InternetModus = 'dns-fehler' | 'haengt'
let internet: InternetModus = 'haengt'
const nachAussen: string[] = []
const ohneZeitlimit: string[] = []
const echtesFetch = globalThis.fetch

function istLan(url: string): boolean {
  const host = new URL(url).hostname
  return host === 'localhost' || host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.')
}

/** fetch wie ohne Internet: LAN geht durch, alles andere scheitert sofort oder hängt bis zum Abbruch */
function fetchOhneInternet(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (istLan(url)) return echtesFetch(input, init)
  nachAussen.push(url)
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  if (!signal) ohneZeitlimit.push(url)
  if (internet === 'dns-fehler') {
    return Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`), { code: 'ENOTFOUND' }) }))
  }
  return new Promise((_, reject) => {
    // Ohne Abbruch durch den Aufrufer: erst nach dem TCP-Zeitlimit des Betriebssystems
    const t = setTimeout(() => reject(new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') })), 60_000)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    }, { once: true })
  })
}

// FinanzOnline ist ohne Internet nicht erreichbar (das echte BMF-System darf der Test nie berühren)
function foOhneInternet(): FinanzOnlineClient {
  const weg = () => Promise.reject(new Error('FinanzOnline login nicht erreichbar: fetch failed'))
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),   // Einrichtung lief noch mit Internet
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'LAN-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(weg),
    seeAusfallMelden:              vi.fn(weg),
    seeWiederinbetriebnahmeMelden: vi.fn(weg),
  } as unknown as FinanzOnlineClient
}

// ── LAN-Geräte mit fixer IP ─────────────────────────────────────────────────

interface LanGeraet {
  ip:        string
  port:      number
  /** Inhalt je Verbindung (ESC/POS-Bytes als latin1-Text) */
  auftraege: string[]
  server:    Server
}

/** TCP-Gerät (Drucker/KDS) auf fester IP; port 0 = frei wählen */
function lanGeraet(ip: string, port = 0): Promise<LanGeraet> {
  return new Promise((resolve, reject) => {
    const auftraege: string[] = []
    const server = createServer((socket: Socket) => {
      const teile: Buffer[] = []
      socket.on('data', d => teile.push(d))
      socket.on('end', () => { if (teile.length) auftraege.push(Buffer.concat(teile).toString('latin1')) })
      socket.on('close', () => {
        const text = Buffer.concat(teile).toString('latin1')
        if (text && !auftraege.includes(text)) auftraege.push(text)
      })
      socket.on('error', () => undefined)
    })
    server.once('error', reject)
    server.listen(port, ip, () => resolve({ ip, port: (server.address() as AddressInfo).port, auftraege, server }))
  })
}

/** Mailserver, der die Verbindung annimmt und nie antwortet (DNS/Route ins Leere) */
function haengenderMailserver(): Promise<{ server: Server; port: number; verbindungen: () => number; sockets: Socket[] }> {
  return new Promise(resolve => {
    const sockets: Socket[] = []
    const server = createServer(s => { sockets.push(s); s.on('error', () => undefined) })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, verbindungen: () => sockets.length, sockets }))
  })
}

async function gemessen<T>(fn: () => Promise<T>): Promise<{ ergebnis: T; ms: number }> {
  const start = Date.now()
  const ergebnis = await fn()
  return { ergebnis, ms: Date.now() - start }
}

const wienHeute = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' }).format(new Date())

// ── Test ────────────────────────────────────────────────────────────────────

describe('LAN ohne Internet: Bonierdrucker, KDS, Verkauf, Z-Bon (Integration, echtes PostgreSQL + TCP)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  let bondrucker: LanGeraet, schank: LanGeraet, kueche: LanGeraet
  let kdsKueche: LanGeraet, kdsSchank: LanGeraet
  let mail: Awaited<ReturnType<typeof haengenderMailserver>>
  let colaId = '', schnitzelId = ''

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = async (url: string, payload: unknown) => {
    const res = await srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
    if (res.statusCode !== 201) throw new Error(`POST ${url} (${res.statusCode}): ${res.body}`)
    return res.json() as { id: string }
  }
  const bonieren = (tisch: string) => srv.fastify.inject({
    method: 'POST', url: '/api/bestellung/bonieren', headers: auth(),
    payload: { kasseId, tisch, kellner: 'Mia', positionen: [{ artikelId: colaId, menge: 2 }, { artikelId: schnitzelId, menge: 1 }] },
  })
  const verkaufen = () => srv.fastify.inject({
    method: 'POST', url: '/api/belege/barzahlung', headers: auth(),
    payload: { kasseId, positionen: [{ artikelId: colaId, menge: 1 }], zahlung: { barCent: 400, karteCent: 0, sonstigeCent: 0 } },
  })
  const warteAuf = async (bedingung: () => boolean, ms = 3000) => {
    const ende = Date.now() + ms
    while (!bedingung() && Date.now() < ende) await new Promise(r => setTimeout(r, 25))
    return bedingung()
  }

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchOhneInternet as typeof fetch)

    // Fixe IPs wie im Netzplan: Bondrucker .10, Schank .11, Küche .12; KDS-Geräte .20/.21 (gemeinsamer KDS-Port)
    bondrucker = await lanGeraet('127.0.0.10')
    schank     = await lanGeraet('127.0.0.11')
    kueche     = await lanGeraet('127.0.0.12')
    kdsKueche  = await lanGeraet('127.0.0.20')
    kdsSchank  = await lanGeraet('127.0.0.21', kdsKueche.port)
    mail       = await haengenderMailserver()

    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: foOhneInternet(),
      config: { SMTP_HOST: '127.0.0.1', SMTP_PORT: mail.port, SMTP_USER: 'kassa', SMTP_PASS: 'geheim', SMTP_FROM: 'kassa@example.at' },
    })
    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'LAN Offline GmbH', uid: 'ATU99999912', kassenId: 'LAN-001',
        finanzOnline: { teilnehmerId: 'T', benutzerkennung: 'B', pin: 'P' }, umgebung: 'test',
        admin: { name: 'LAN Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    const schankDrucker = await post('/api/bonierdrucker', { name: 'Schank .11', ip: schank.ip, port: schank.port })
    const kuecheDrucker = await post('/api/bonierdrucker', { name: 'Küche .12',  ip: kueche.ip, port: kueche.port })
    colaId      = (await post('/api/artikel', { bezeichnung: 'Cola', preisBruttoCent: 400, mwstSatz: 'normal', station: 'schank', bonierdruckerId: schankDrucker.id })).id
    schnitzelId = (await post('/api/artikel', { bezeichnung: 'Schnitzel', preisBruttoCent: 1450, mwstSatz: 'ermaessigt1', station: 'kueche', bonierdruckerId: kuecheDrucker.id })).id

    // Bondrucker der Kasse (.10) und Empfänger der Z-Bon-Mail
    await idb.db.update(kassen).set({
      druckerIp: bondrucker.ip, druckerPort: bondrucker.port, druckerAktiv: true, abschlussEmail: 'chef@example.at',
    }).where(eq(kassen.id, kasseId))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    for (const s of mail?.sockets ?? []) s.destroy()
    for (const g of [bondrucker, schank, kueche, kdsKueche, kdsSchank]) g?.server.close()
    mail?.server.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  describe('Bestellsystem ohne Beleg (Bonieren)', () => {
    it.each(['haengt', 'dns-fehler'] as const)('Internet %s: Schank- und Küchendrucker drucken sofort, getrennt nach Station', async (modus) => {
      internet = modus
      const vorherSchank = schank.auftraege.length, vorherKueche = kueche.auftraege.length
      const { ergebnis: res, ms } = await gemessen(() => bonieren(`Tisch ${modus}`))
      expect(res.statusCode, res.body).toBe(200)
      expect(ms).toBeLessThan(2000)
      expect(await warteAuf(() => schank.auftraege.length > vorherSchank && kueche.auftraege.length > vorherKueche)).toBe(true)
      expect(schank.auftraege.at(-1)).toContain('Cola')
      expect(schank.auftraege.at(-1)).not.toContain('Schnitzel')
      expect(kueche.auftraege.at(-1)).toContain('Schnitzel')
      expect(kueche.auftraege.at(-1)).not.toContain('Cola')
    })

    it('KDS-Geräte mit fixer IP bekommen ihre Station, der Browser-KDS zeigt den Bon', async () => {
      internet = 'haengt'
      await idb.db.update(kassen).set({
        kdsAktiv: true, kdsPort: kdsKueche.port, kdsStationen: { kueche: kdsKueche.ip, schank: kdsSchank.ip },
      }).where(eq(kassen.id, kasseId))
      try {
        const vorK = kdsKueche.auftraege.length, vorS = kdsSchank.auftraege.length
        const { ergebnis: res, ms } = await gemessen(() => bonieren('Tisch KDS'))
        expect(res.statusCode, res.body).toBe(200)
        expect(ms).toBeLessThan(2000)
        expect(await warteAuf(() => kdsKueche.auftraege.length > vorK && kdsSchank.auftraege.length > vorS)).toBe(true)
        expect(kdsKueche.auftraege.at(-1)).toContain('Schnitzel')
        expect(kdsSchank.auftraege.at(-1)).toContain('Cola')

        const bons = (await srv.fastify.inject({ method: 'GET', url: '/api/kds/bons?station=kueche', headers: auth() })).json() as Array<{ positionen: unknown }>
        expect(JSON.stringify(bons)).toContain('Schnitzel')
      } finally {
        await idb.db.update(kassen).set({ kdsAktiv: false, kdsStationen: {} }).where(eq(kassen.id, kasseId))
      }
    })
  })

  describe('Verkauf mit lokal signierender Signatureinheit', () => {
    it('signierter Beleg (kein Ausfall) und Bon am Bondrucker — ohne Wartezeit', async () => {
      internet = 'haengt'
      const vorher = bondrucker.auftraege.length
      const { ergebnis: res, ms } = await gemessen(verkaufen)
      expect(res.statusCode, res.body).toBe(201)
      expect(ms).toBeLessThan(2000)
      expect(istAusfallBeleg(res.json().signaturwert)).toBe(false)
      expect(await warteAuf(() => bondrucker.auftraege.length > vorher)).toBe(true)
    })
  })

  describe('Z-Bon mit Mail-Versand, Mailserver nicht erreichbar', () => {
    it('druckt sofort; die Mail hält den Ausdruck nicht auf', async () => {
      const vorher = bondrucker.auftraege.length
      const { ergebnis: res, ms } = await gemessen(() => srv.fastify.inject({
        method: 'POST', url: '/api/belege/tagesabschluss/drucken', headers: auth(),
        payload: { kasseId, datum: wienHeute() },
      }))
      expect(res.statusCode, res.body).toBeLessThan(300)
      expect(ms).toBeLessThan(3000)
      expect(await warteAuf(() => bondrucker.auftraege.length > vorher)).toBe(true)
      // Der Mailversuch läuft (und hängt) im Hintergrund
      expect(await warteAuf(() => mail.verbindungen() > 0)).toBe(true)
    })
  })

  describe('Update-Prüfung ohne Internet', () => {
    it('Statusabfrage antwortet, und die nächste wartet nicht erneut auf GitHub', async () => {
      internet = 'dns-fehler'
      const erste = await srv.fastify.inject({ method: 'GET', url: '/api/system/status', headers: auth() })
      expect(erste.statusCode).toBe(200)
      expect(erste.json().neueste).toBeNull()
      const aufrufe = nachAussen.filter(u => u.includes('github')).length
      expect(aufrufe).toBeGreaterThan(0)

      internet = 'haengt'
      const { ergebnis: zweite, ms } = await gemessen(() => srv.fastify.inject({ method: 'GET', url: '/api/system/status', headers: auth() }))
      expect(zweite.statusCode).toBe(200)
      expect(ms).toBeLessThan(1000)
      expect(nachAussen.filter(u => u.includes('github')).length).toBe(aufrufe)
    })
  })

  describe('Verkauf mit A-Trust (online), Internet hängt', () => {
    it('erster Verkauf: Ausfallmodus nach dem Zeitlimit, Bon wird gedruckt; danach ohne Wartezeit', async () => {
      internet = 'haengt'
      await idb.db.update(kassen).set({
        seeTyp:            'atrust_hsm',
        atrustBasisUrl:    'https://hs.a-trust.at/RegistrierkasseMobile/v2',
        atrustBenutzer:    'u123456789',
        atrustPasswortEnc: encryptPrivateKey(Buffer.from('geheim', 'utf8'), TEST_MASTER),
      }).where(eq(kassen.id, kasseId))

      const vorher = bondrucker.auftraege.length
      const erst = await gemessen(verkaufen)
      expect(erst.ergebnis.statusCode, erst.ergebnis.body).toBe(201)
      expect(istAusfallBeleg(erst.ergebnis.json().signaturwert)).toBe(true)
      expect(erst.ms).toBeLessThan(6000)            // A-Trust-Zeitlimit 2,5 s (+ Puffer)
      expect(nachAussen.some(u => u.includes('a-trust.at'))).toBe(true)
      expect(await warteAuf(() => bondrucker.auftraege.length > vorher)).toBe(true)

      const [kasse] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
      expect(kasse!.seeAusgefallenSeit).not.toBeNull()

      // Im Ausfallmodus fragt der Verkauf A-Trust nicht mehr — kein Warten pro Beleg
      const danach = await gemessen(verkaufen)
      expect(danach.ergebnis.statusCode).toBe(201)
      expect(istAusfallBeleg(danach.ergebnis.json().signaturwert)).toBe(true)
      expect(danach.ms).toBeLessThan(1500)
    })

    it('DNS findet A-Trust nicht: sofort Ausfallmodus statt Fehler', async () => {
      internet = 'dns-fehler'
      await idb.db.update(kassen).set({ seeAusgefallenSeit: null }).where(eq(kassen.id, kasseId))
      const { ergebnis: res, ms } = await gemessen(verkaufen)
      expect(res.statusCode, res.body).toBe(201)
      expect(istAusfallBeleg(res.json().signaturwert)).toBe(true)
      expect(ms).toBeLessThan(2000)
    })
  })

  it('kein Aufruf ins Internet ohne Zeitlimit (er hinge sonst bis zum TCP-Zeitlimit des Systems)', () => {
    expect(nachAussen.length).toBeGreaterThan(0)
    expect(ohneZeitlimit).toEqual([])
  })
})
