/**
 * Integrationstest: Rate-Limit je echtem Client (echtes PostgreSQL).
 *
 * Das Backend sieht als Absender nur den nginx der jeweiligen App. Früher
 * teilten sich deshalb ALLE Clients einer App einen Zähler; und wo es eigene
 * Schlüssel gab, stammten sie aus fälschbaren Headern (erster X-Forwarded-For-
 * Eintrag, ungeprüfter Authorization-Header).
 *
 * Kernpunkte:
 *  - zwei Clients hinter demselben App-nginx zählen getrennt (X-Real-IP, das
 *    der nginx setzt)
 *  - gefälschter X-Forwarded-For, Müll in X-Real-IP, kaputte oder fremd
 *    signierte Tokens erzeugen KEINEN neuen Zähler
 *  - angemeldete Geräte zählen je Anmeldung — auch hinter derselben
 *    Gateway-Adresse (Docker Desktop), SSE-?token= inklusive
 *  - Login-Bremse und Ticketseite je Client-IP; Einlass je Gerät
 *  - Audit-Log speichert die Client-IP aus X-Real-IP
 */

import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { auditLogs } from '../../src/db/schema.js'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'RL-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const EMAIL    = 'admin@ratelimit-test.at'
const PASSWORT = 'ratelimit-passwort-123'

/** Globales Limit dieses Test-Servers (Anfragen/Minute je Client). */
const MAX = 5

/** Absender aller Anfragen „über den App-nginx" (Container im Docker-Netz). */
const NGINX = '172.18.0.5'

/** Wie der App-nginx die Anfrage weiterreicht: X-Real-IP = von ihm bestimmte Client-IP. */
const ueberNginx = (clientIp: string, headers: Record<string, string> = {}) => ({
  remoteAddress: NGINX,
  headers: { 'x-real-ip': clientIp, ...headers },
})

/** JWT mit fremdem Schlüssel — formal gültig, aber nicht von diesem Backend. */
function fremdSigniert(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const kopf = b64({ alg: 'HS256', typ: 'JWT' })
  const rumpf = b64(payload)
  const sig = createHmac('sha256', 'ein-voellig-anderes-geheimnis-mit-mindestens-32-zeichen')
    .update(`${kopf}.${rumpf}`).digest('base64url')
  return `${kopf}.${rumpf}.${sig}`
}

describe('Rate-Limit je Client (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let admin: { token: string; userId: string; mandantId: string; kasseId: string }

  /**
   * Eigener Token je „Gerät": gleicher Benutzer, andere Ausstellzeit = andere
   * Anmeldung. Ausstellzeit knapp in der Vergangenheit — der Test-Token gilt
   * 1 h ab iat.
   */
  let naechsteIat = Math.floor(Date.now() / 1000) - 120
  const neueAnmeldung = () => srv.fastify.jwt.sign({
    sub: admin.userId, mandantId: admin.mandantId, rolle: 'admin', name: 'Gerät', berechtigungen: [],
    iat: naechsteIat++,
  })

  const health = (clientIp: string, headers: Record<string, string> = {}) =>
    srv.fastify.inject({ method: 'GET', url: '/api/health', ...ueberNginx(clientIp, headers) })
  const ich = (clientIp: string, token: string) =>
    srv.fastify.inject({ method: 'GET', url: '/api/auth/me', ...ueberNginx(clientIp, { authorization: `Bearer ${token}` }) })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient(), rateLimitMax: MAX })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Ratelimit Test OG', uid: 'ATU99999941', kassenId: 'RL-001',
        finanzOnline: { teilnehmerId: 'TID-RL', benutzerkennung: 'BID-RL', pin: 'PIN-RL' },
        umgebung: 'test',
        admin: { name: 'RL Admin', email: EMAIL, passwort: PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.body}`)
    const login = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, passwort: PASSWORT } })
    if (login.statusCode !== 200) throw new Error(`Login: ${login.body}`)
    const l = login.json()
    admin = { token: l.token, userId: l.user.id, mandantId: l.mandant.id, kasseId: l.kassen[0].id }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('zwei Clients hinter demselben App-nginx haben getrennte Zähler', async () => {
    for (let i = 0; i < MAX; i++) expect((await health('192.168.192.50')).statusCode).toBe(200)
    const zuViel = await health('192.168.192.50')
    // 429 (nicht 500 — der errorResponseBuilder muss den statusCode mitgeben)
    expect(zuViel.statusCode).toBe(429)
    expect(zuViel.json()).toEqual({ statusCode: 429, fehler: expect.stringContaining('Zu viele Anfragen') })
    expect(zuViel.headers['retry-after']).toBeDefined()
    // Nachbar am selben nginx: eigener, frischer Zähler
    expect((await health('192.168.192.51')).statusCode).toBe(200)
  })

  it('ein gefälschter X-Forwarded-For erzeugt keinen neuen Zähler', async () => {
    const ip = '192.168.192.60'
    for (let i = 0; i < MAX; i++) {
      expect((await health(ip, { 'x-forwarded-for': `6.6.6.${i}` })).statusCode).toBe(200)
    }
    expect((await health(ip, { 'x-forwarded-for': '6.6.6.99' })).statusCode).toBe(429)
    expect((await health(ip, { 'x-forwarded-for': '203.0.113.7, 6.6.6.100' })).statusCode).toBe(429)
  })

  it('Müll in X-Real-IP zählt beim Absender — kein Zähler je erfundenem Wert', async () => {
    const anderNginx = { remoteAddress: '172.18.0.9' }
    const mit = (wert: string) => srv.fastify.inject({ method: 'GET', url: '/api/health', ...anderNginx, headers: { 'x-real-ip': wert } })
    for (let i = 0; i < MAX; i++) expect((await mit(`kein-ip-${i}`)).statusCode).toBe(200)
    expect((await mit('auch-keine-ip')).statusCode).toBe(429)
  })

  it('angemeldete Geräte hinter derselben Gateway-IP zählen je Anmeldung (Docker Desktop)', async () => {
    // Docker Desktop: der App-nginx sieht für JEDEN LAN-Client die Gateway-Adresse
    const gateway = '172.18.0.1'
    const kasse1 = neueAnmeldung()
    const kasse2 = neueAnmeldung()   // derselbe Benutzer an einer zweiten Kasse
    for (let i = 0; i < MAX; i++) expect((await ich(gateway, kasse1)).statusCode).toBe(200)
    expect((await ich(gateway, kasse1)).statusCode).toBe(429)
    expect((await ich(gateway, kasse2)).statusCode).toBe(200)
    // anonyme Anfragen derselben Adresse haben wiederum ihren eigenen Zähler
    expect((await health(gateway)).statusCode).toBe(200)
  })

  it('SSE-Token in ?token= zählt in denselben Topf wie der Authorization-Header', async () => {
    const token = neueAnmeldung()
    for (let i = 0; i < MAX; i++) expect((await ich('192.168.192.65', token)).statusCode).toBe(200)
    const perQuery = await srv.fastify.inject({
      method: 'GET', url: `/api/health?token=${encodeURIComponent(token)}`, ...ueberNginx('192.168.192.66'),
    })
    expect(perQuery.statusCode).toBe(429)
  })

  it('kaputte oder fremd signierte Tokens öffnen keinen eigenen Topf', async () => {
    const ip = '192.168.192.70'
    for (let i = 0; i < MAX; i++) {
      expect((await health(ip, { authorization: `Bearer kaputt.${i}.token` })).statusCode).toBe(200)
    }
    const fremd = fremdSigniert({ sub: admin.userId, mandantId: admin.mandantId, rolle: 'admin', iat: 1 })
    expect((await health(ip, { authorization: `Bearer ${fremd}` })).statusCode).toBe(429)
    // auch ein abgelaufener, echt signierter Token zählt als anonym
    const abgelaufen = srv.fastify.jwt.sign({
      sub: admin.userId, mandantId: admin.mandantId, rolle: 'admin', name: 'x', berechtigungen: [],
      iat: 1, exp: 2,
    })
    expect((await health(ip, { authorization: `Bearer ${abgelaufen}` })).statusCode).toBe(429)
  })

  it('Login-Bremse zählt je Client-IP — ein mitgeschickter Token verschafft keinen eigenen Topf', async () => {
    const pinLogin = (clientIp: string, headers: Record<string, string> = {}) => srv.fastify.inject({
      method: 'POST', url: '/api/auth/pin-login', ...ueberNginx(clientIp, headers),
      payload: { kasseId: admin.kasseId, pin: '0000' },
    })
    const ip = '192.168.192.80'
    for (let i = 0; i < 10; i++) expect((await pinLogin(ip)).statusCode).not.toBe(429)
    expect((await pinLogin(ip)).statusCode).toBe(429)
    expect((await pinLogin(ip, { authorization: `Bearer ${neueAnmeldung()}` })).statusCode).toBe(429)
    expect((await pinLogin(ip, { 'x-forwarded-for': '6.6.6.6' })).statusCode).toBe(429)
    // anderes Handy im selben LAN (Linux-Host: echte IP) — eigener Zähler
    expect((await pinLogin('192.168.192.81')).statusCode).not.toBe(429)
  })

  it('Ticketseite zählt je Gast — gefälschter X-Forwarded-For hilft nicht', async () => {
    const unbekannt = '/api/ticketshop/ticket/abcdefghjkmnpqrs'
    const abruf = (clientIp: string, headers: Record<string, string> = {}) =>
      srv.fastify.inject({ method: 'GET', url: unbekannt, ...ueberNginx(clientIp, headers) })
    for (let i = 0; i < 60; i++) {
      expect((await abruf('203.0.113.10', { 'x-forwarded-for': `6.6.${i}.1` })).statusCode).toBe(404)
    }
    expect((await abruf('203.0.113.10', { 'x-forwarded-for': '6.6.99.1' })).statusCode).toBe(429)
    expect((await abruf('203.0.113.11')).statusCode).toBe(404)
  })

  it('Einlass zählt je geprüftem Geräte-Token, ein gefälschter Token wird vorher abgewiesen', async () => {
    const adminAuth = { authorization: `Bearer ${admin.token}` }
    await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: adminAuth, payload: { modulTicketsAktiv: true } })
    const geraet = async (name: string) => {
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/ticketing/einlass-geraete', headers: adminAuth, payload: { name } })
      expect(res.statusCode).toBe(201)
      return res.json().token as string
    }
    const scannerA = await geraet('Scanner A')
    const scannerB = await geraet('Scanner B')
    const ichGeraet = (token: string) =>
      srv.fastify.inject({ method: 'GET', url: '/api/einlass/ich', ...ueberNginx('172.18.0.1', { authorization: `Bearer ${token}` }) })

    const a1 = await ichGeraet(scannerA)
    const a2 = await ichGeraet(scannerA)
    const b1 = await ichGeraet(scannerB)
    expect(a1.statusCode).toBe(200)
    expect(a1.headers['x-ratelimit-limit']).toBe('600')
    expect(a1.headers['x-ratelimit-remaining']).toBe('599')
    expect(a2.headers['x-ratelimit-remaining']).toBe('598')
    // zweites Gerät hinter derselben Adresse: eigener Zähler
    expect(b1.headers['x-ratelimit-remaining']).toBe('599')

    const gefaelscht = await ichGeraet('erfunden.token.wert')
    expect(gefaelscht.statusCode).toBe(401)
    expect(gefaelscht.headers['x-ratelimit-remaining']).toBeUndefined()
  })

  it('Audit-Log speichert die Client-IP aus X-Real-IP, nicht den ersten X-Forwarded-For-Eintrag', async () => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login',
      ...ueberNginx('192.168.192.90', { 'x-forwarded-for': '6.6.6.6, 192.168.192.90' }),
      payload: { email: EMAIL, passwort: PASSWORT },
    })
    expect(res.statusCode).toBe(200)
    const eintraege = await idb.db.select({ ip: auditLogs.ipAdresse }).from(auditLogs)
      .where(and(eq(auditLogs.aktion, 'login.erfolg'), eq(auditLogs.ipAdresse, '192.168.192.90')))
    expect(eintraege).toHaveLength(1)
    const gefaelscht = await idb.db.select({ ip: auditLogs.ipAdresse }).from(auditLogs)
      .where(eq(auditLogs.ipAdresse, '6.6.6.6'))
    expect(gefaelscht).toHaveLength(0)
  })
})
