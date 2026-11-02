/**
 * Integrationstest: Bestätigungsmail der öffentlichen Online-Buchung.
 *
 * Die Route ist öffentlich, die Mail geht über den SMTP-Zugang des Betriebs an eine frei wählbare Adresse.
 * Zwei Dinge dürfen darin nicht von außen kommen:
 *   - Eingaben des Gastes (Name, Anmerkung) stehen im HTML → maskieren, sonst baut sich der Absender damit
 *     beliebigen Inhalt (Links, Formulare) in eine Mail, die vom Betrieb zu kommen scheint
 *   - die Adresse hinter „Reservierung stornieren" → aus der Konfiguration (CORS_ORIGIN), nie aus Host /
 *     X-Forwarded-Host, die jeder Aufrufer selbst setzt
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { kassen, mandanten } from '../../src/db/schema.js'

// nodemailer abfangen: geprüft wird die tatsächlich gebaute Mail
const { gesendet } = vi.hoisted(() => ({ gesendet: [] as Array<Record<string, unknown>> }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => { gesendet.push(mail); return { messageId: 'test' } },
    }),
  },
}))

const SMTP = { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'kassa@test.at' }

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BM-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

describe('Online-Buchung: Bestätigungsmail (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer          // CORS_ORIGIN = die Adresse des Betriebs
  let srvOhneAdresse: TestServer
  let kasseId = ''

  const buchen = (server: TestServer, extra: Record<string, unknown> = {}) => server.fastify.inject({
    method: 'POST', url: `/api/buchung/${kasseId}`,
    // Ein Angreifer setzt die Header, wie er will
    headers: { host: 'phishing.example', 'x-forwarded-host': 'phishing.example', 'x-forwarded-proto': 'https' },
    payload: {
      datum: '2026-09-20', zeitVon: '19:00', personenAnzahl: 2, name: 'Max Muster',
      email: 'opfer@example.com', ...extra,
    },
  })

  /** Die Mail wird ohne Warten versendet (fire-and-forget) — kurz abwarten, bis sie "raus" ist. */
  async function abwarten(): Promise<{ html: string; to: string }> {
    for (let i = 0; i < 60 && gesendet.length === 0; i++) await new Promise(r => setTimeout(r, 25))
    expect(gesendet).toHaveLength(1)
    return { html: String(gesendet[0]!['html']), to: String(gesendet[0]!['to']) }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      config: { ...SMTP, CORS_ORIGIN: 'https://kasse.example.com' },
    })
    srvOhneAdresse = await buildTestServer(idb.db, {
      finanzOnlineClient: mockFoClient(),
      config: { ...SMTP, CORS_ORIGIN: '*' },
    })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Buchungsmail <b>GmbH</b>', uid: 'ATU55555501', kassenId: 'BM-001', umgebung: 'test',
        finanzOnline: { teilnehmerId: 'TID-BM', benutzerkennung: 'BID-BM', pin: 'PIN-BM' },
        admin: { name: 'BM Admin', email: 'admin@buchung-mail.at', passwort: 'buchung-mail-123' },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup: ${setup.statusCode} ${setup.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'admin@buchung-mail.at', passwort: 'buchung-mail-123' },
    })).json()
    kasseId = login.kassen[0].id
    await idb.db.update(mandanten).set({ modulReservierungenAktiv: true }).where(eq(mandanten.id, login.mandant.id))
    await idb.db.update(kassen).set({ onlineBuchungAktiv: true }).where(eq(kassen.id, kasseId))
  })

  afterAll(async () => {
    await srvOhneAdresse?.close()
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => { gesendet.length = 0 })

  it('der Stornierlink führt auf die Adresse des Betriebs — nie auf den Host der Anfrage', async () => {
    const res = await buchen(srv)
    expect(res.statusCode).toBe(201)
    const { html, to } = await abwarten()

    expect(to).toBe('opfer@example.com')
    // (im HTML-Attribut steht das & als &amp; — so gehört es sich)
    expect(html).toContain(`href="https://kasse.example.com/buchung?kasseId=${kasseId}&amp;stornieren=`)
    expect(html).not.toContain('phishing.example')
  })

  it('Eingaben des Gastes und der Firmenname stehen maskiert in der Mail', async () => {
    const res = await buchen(srv, {
      name:  '<img src=x onerror=alert(1)>Max',
      notiz: '<a href="https://evil.example/login">Jetzt Passwort bestätigen</a>',
    })
    expect(res.statusCode).toBe(201)
    const { html } = await abwarten()

    // Die Zeichen sind maskiert, aus dem Text wird kein Element
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;Max')
    expect(html).toContain('&lt;a href=&quot;https://evil.example/login&quot;&gt;Jetzt Passwort bestätigen&lt;/a&gt;')
    expect(html).toContain('Buchungsmail &lt;b&gt;GmbH&lt;/b&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<a href="https://evil.example')
    expect(html).not.toContain('<b>GmbH')
  })

  it('ohne verwertbare Adresse in der Konfiguration kommt die Mail ohne Stornierlink', async () => {
    const res = await buchen(srvOhneAdresse)
    expect(res.statusCode).toBe(201)
    const { html } = await abwarten()

    expect(html).not.toContain('stornieren=')
    expect(html).not.toContain('Reservierung stornieren')
    expect(html).not.toContain('phishing.example')
  })
})
