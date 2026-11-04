/**
 * Integrationstest: Wartungsrechnungen — automatischer Mailversand, Offene Posten, Sammelliste für die
 * Buchhaltung, Zahlungsangaben und Schutz vor doppelter Verrechnung.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Config } from '../../src/config.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { lieferscheine, sammelrechnungen } from '../../src/db/schema.js'
import { erstelleSammelrechnung } from '../../src/services/lieferschein.service.js'
import { fuehreAutoRechnungenDurch, fuehreWartungslaufDurch } from '../../src/services/wartungsvertrag.service.js'

// nodemailer abfangen: geprüft wird die tatsächlich gebaute Mail
const { gesendet, steuerung } = vi.hoisted(() => ({
  gesendet:  [] as Array<Record<string, unknown>>,
  steuerung: { fehler: false },
}))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => {
        if (steuerung.fehler) throw new Error('SMTP nicht erreichbar')
        gesendet.push(mail)
        return { messageId: 'test' }
      },
    }),
  },
}))

const SMTP = { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'kassa@test.at' }
const CONFIG = SMTP as unknown as Config
const ADMIN_EMAIL    = 'admin@wartungsrechnung.at'
const ADMIN_PASSWORT = 'wartungsrechnung-passwort-123'
const GUELTIGE_IBAN  = 'AT61 1904 3002 3457 3201'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:    vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'WR-PW' }),
  } as unknown as FinanzOnlineClient
}

const am = (datum: string) => new Date(`${datum}T10:00:00Z`)

describe('Wartungsrechnungen: Mailversand + Buchhaltung (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let mandantId: string
  let kasseId: string

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function neuerKunde(payload: Record<string, unknown>) {
    const res = await srv.fastify.inject({ method: 'POST', url: '/api/kunden', headers: auth(), payload })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as { id: string }
  }

  async function neuerVertrag(kundeId: string, extra: Record<string, unknown> = {}) {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/wartungsvertraege', headers: auth(),
      payload: {
        kasseId, kundeId, bezeichnung: 'Kassa-Wartung', beginn: '2026-09-01', rechnungsIntervall: 'monatlich',
        positionen: [{ bezeichnung: 'Support', einzelpreisBreutto: 5000, mwstSatz: 'normal' }],
        ...extra,
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as { id: string; nummer: number }
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient(), config: SMTP })

    const setupRes = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Wartungsrechnung GmbH', uid: 'ATU99999933', kassenId: 'WR-001',
        finanzOnline: { teilnehmerId: 'TID-WR', benutzerkennung: 'BID-WR', pin: 'PIN-WR' },
        umgebung: 'test',
        admin: { name: 'WR Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setupRes.statusCode !== 201) throw new Error(`Setup fehlgeschlagen: ${setupRes.body}`)

    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token     = login.token
    kasseId   = login.kassen[0].id
    mandantId = login.user?.mandantId ?? login.mandantId
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => {
    gesendet.length = 0
    steuerung.fehler = false
  })

  it('Zahlungsangaben: gültige IBAN wird normalisiert gespeichert, ungültige abgewiesen', async () => {
    const schlecht = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/stammdaten', headers: auth(), payload: { rechnungIban: 'AT00 1234 5678 9012 3456' },
    })
    expect(schlecht.statusCode).toBe(400)

    const gut = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/stammdaten', headers: auth(),
      payload: { rechnungIban: GUELTIGE_IBAN, rechnungBic: 'bkauatww', rechnungZahlungszielTage: 21 },
    })
    expect(gut.statusCode, gut.body).toBe(200)
    expect(gut.json()).toMatchObject({ rechnungIban: 'AT611904300234573201', rechnungBic: 'BKAUATWW', rechnungZahlungszielTage: 21 })
  })

  it('Kunde mit Rechnungsversand per Mail braucht eine E-Mail-Adresse', async () => {
    const ohne = await srv.fastify.inject({
      method: 'POST', url: '/api/kunden', headers: auth(), payload: { firma: 'Ohne Mail GmbH', rechnungPerMail: true },
    })
    expect(ohne.statusCode).toBe(400)

    const kunde = await neuerKunde({ firma: 'Später Mail GmbH' })
    const patch = await srv.fastify.inject({
      method: 'PUT', url: `/api/kunden/${kunde.id}`, headers: auth(), payload: { rechnungPerMail: true },
    })
    expect(patch.statusCode).toBe(400)
  })

  it('Automatik: fällige Rechnung wird erstellt, verschickt, als offener Posten geführt und landet in der Buchhaltungsliste', async () => {
    const kunde   = await neuerKunde({ firma: 'Wirtshaus Auto', email: 'wirt@auto.at', rechnungPerMail: true })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })

    const lauf = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(lauf.erstellt).toBe(1)

    expect(gesendet).toHaveLength(1)
    expect(gesendet[0]!['to']).toBe('wirt@auto.at')
    const html = String(gesendet[0]!['html'])
    expect(html).toContain('AT611904300234573201')
    expect(html).toContain('BKAUATWW')
    expect(html).toContain('Zahlbar bis')
    expect(html).toContain('21 Tage')

    const [sr] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vertrag.id))
    expect(sr?.emailVersandtAm).not.toBeNull()
    expect(sr?.gesamtbetragCent).toBe(5000)
    const ls = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, vertrag.id))
    expect(ls.every(l => l.status === 'abgeschlossen')).toBe(true)

    const op = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as
      Array<{ betragCent: number; notiz?: string; kunde?: { bezeichnung: string } }>
    expect(op.some(o => o.betragCent === 5000 && o.notiz?.includes('Wartungsvertrag'))).toBe(true)

    // Zweiter Lauf: nichts mehr zu tun, keine zweite Mail
    const nochmal = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(nochmal.erstellt).toBe(0)
    expect(gesendet).toHaveLength(1)

    // Buchhaltung: Sammelliste, danach als gedruckt markieren
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as
      Array<{ id: string; emailEmpfaenger?: string }>
    const meine = liste.filter(r => r.id === sr!.id)
    expect(meine).toHaveLength(1)
    expect(meine[0]!.emailEmpfaenger).toBe('wirt@auto.at')

    const gedruckt = await srv.fastify.inject({
      method: 'POST', url: '/api/sammelrechnungen/buchhaltung/gedruckt', headers: auth(), payload: { ids: [sr!.id] },
    })
    expect(gedruckt.json()).toEqual({ markiert: 1 })
    const danach = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(danach.some(r => r.id === sr!.id)).toBe(false)
    const doppelt = await srv.fastify.inject({
      method: 'POST', url: '/api/sammelrechnungen/buchhaltung/gedruckt', headers: auth(), payload: { ids: [sr!.id] },
    })
    expect(doppelt.json()).toEqual({ markiert: 0 })
  })

  it('Mailfehler: Rechnung bleibt bestehen, Fehler wird vermerkt, der nächste Lauf versendet genau einmal nach', async () => {
    const kunde   = await neuerKunde({ firma: 'Wirtshaus Retry', email: 'wirt@retry.at', rechnungPerMail: true })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })

    steuerung.fehler = true
    const erster = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(erster.erstellt).toBe(1)
    expect(gesendet).toHaveLength(0)

    const [fehlerhaft] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vertrag.id))
    expect(fehlerhaft?.emailVersandtAm).toBeNull()
    expect(fehlerhaft?.emailFehler).toContain('SMTP nicht erreichbar')
    // Nicht zugestellt → nicht in der Buchhaltungsliste
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(liste.some(r => r.id === fehlerhaft!.id)).toBe(false)

    steuerung.fehler = false
    const zweiter = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(zweiter.erstellt).toBe(0)
    expect(zweiter.erneutVersendet).toBe(1)
    expect(gesendet).toHaveLength(1)

    const [ok] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, fehlerhaft!.id))
    expect(ok?.emailVersandtAm).not.toBeNull()
    expect(ok?.emailFehler).toBeNull()
  })

  it('Kunden ohne Mailversand bleiben bei der manuellen Abrechnung; ohne SMTP entstehen keine Auto-Rechnungen', async () => {
    const manuell = await neuerKunde({ firma: 'Wirtshaus Manuell', email: 'wirt@manuell.at' })
    const vM = await neuerVertrag(manuell.id)
    const mail = await neuerKunde({ firma: 'Wirtshaus OhneSmtp', email: 'wirt@ohnesmtp.at', rechnungPerMail: true })
    const vS = await neuerVertrag(mail.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })

    const ohneSmtp = await fuehreAutoRechnungenDurch(idb.db, {} as Config, am('2026-10-02'))
    expect(ohneSmtp).toEqual({ erstellt: 0, erneutVersendet: 0 })
    expect(await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vS.id))).toHaveLength(0)

    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vM.id))).toHaveLength(0)
    expect(await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vS.id))).toHaveLength(1)

    // Manuell abrechnen (Kunde ohne Flag): keine Mail, normaler Ausgabe-Dialog
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/wartungsvertraege/${vM.id}/abrechnen`, headers: auth() })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().emailEmpfaenger).toBeUndefined()
  })

  it('Storno: Rechnung bleibt als storniert bestehen, Lieferscheine sind wieder offen, die Automatik rechnet nicht von selbst neu ab', async () => {
    const kunde   = await neuerKunde({ firma: 'Wirtshaus Storno', email: 'wirt@storno.at', rechnungPerMail: true })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })
    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    const [sr] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vertrag.id))
    expect(sr?.emailVersandtAm).not.toBeNull()
    gesendet.length = 0

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/sammelrechnungen/${sr!.id}/stornieren`, headers: auth(), payload: { grund: 'Falscher Betrag' },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ stornoGrund: 'Falscher Betrag' })
    expect(res.json().storniertAm).toBeTruthy()

    // Lieferschein wieder offen; der offene Posten ist weg; nicht in der Buchhaltungsliste
    const ls = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, vertrag.id))
    expect(ls.every(l => l.status === 'offen' && l.manuellVerrechnen)).toBe(true)
    const op = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as Array<{ notiz?: string }>
    expect(op.some(o => o.notiz?.includes(`SR-${String(sr!.nummer).padStart(4, '0')}`))).toBe(false)
    const buch = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(buch.some(r => r.id === sr!.id)).toBe(false)

    // Doppeltes Storno + Ausgabe einer stornierten Rechnung werden abgewiesen
    const nochmal = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr!.id}/stornieren`, headers: auth(), payload: {} })
    expect(nochmal.statusCode).toBe(409)
    const mail = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr!.id}/email`, headers: auth(), payload: { empfaenger: 'x@y.at' } })
    expect(mail.statusCode).toBe(409)

    // Die Automatik verrechnet die Lieferscheine NICHT von selbst neu und verschickt nichts
    const auto = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(auto.erstellt).toBe(0)
    expect(gesendet).toHaveLength(0)

    // Von Hand sind sie wieder verrechenbar → neue Rechnung mit neuer Nummer
    const neu = await srv.fastify.inject({ method: 'POST', url: `/api/wartungsvertraege/${vertrag.id}/abrechnen`, headers: auth() })
    expect(neu.statusCode, neu.body).toBe(201)
    expect(neu.json().nummer).toBeGreaterThan(sr!.nummer)
    expect(neu.json().storniertAm).toBeUndefined()
  })

  it('Storno ist mit erfasster Zahlung nicht möglich', async () => {
    const kunde   = await neuerKunde({ firma: 'Wirtshaus Gezahlt', email: 'wirt@gezahlt.at', rechnungPerMail: true })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })
    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    const [sr] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vertrag.id))

    const ops = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as Array<{ id: string; notiz?: string }>
    const op  = ops.find(o => o.notiz?.includes(`SR-${String(sr!.nummer).padStart(4, '0')}`))
    expect(op).toBeTruthy()
    const zahlung = await srv.fastify.inject({
      method: 'POST', url: `/api/offene-posten/${op!.id}/zahlung`, headers: auth(), payload: { zahlungCent: 1000 },
    })
    expect(zahlung.statusCode, zahlung.body).toBe(200)

    const storno = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr!.id}/stornieren`, headers: auth(), payload: {} })
    expect(storno.statusCode).toBe(409)
    expect(storno.json().fehler).toContain('Zahlung')
    const [danach] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, sr!.id))
    expect(danach?.storniertAm).toBeNull()
  })

  it('Lieferscheine lassen sich nur einmal verrechnen (paralleler Zugriff)', async () => {
    const kunde = await neuerKunde({ firma: 'Wirtshaus Parallel', email: 'wirt@parallel.at' })
    const v = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })
    const ls = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, v.id))
    expect(ls).toHaveLength(1)

    const ergebnisse = await Promise.allSettled([
      erstelleSammelrechnung(idb.db, mandantId, { lieferscheinIds: [ls[0]!.id] }),
      erstelleSammelrechnung(idb.db, mandantId, { lieferscheinIds: [ls[0]!.id] }),
    ])
    expect(ergebnisse.filter(e => e.status === 'fulfilled')).toHaveLength(1)
    expect(ergebnisse.filter(e => e.status === 'rejected')).toHaveLength(1)
  })
})
