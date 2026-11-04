/**
 * Integrationstest: Wartungsrechnungen — Freigabe vor Versand/Druck, Mailversand, Offene Posten, Ausdruck-Liste,
 * Storno mit automatischer Stornorechnung per Mail, Zahlungsangaben und Schutz vor doppelter Verrechnung.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { Config } from '../../src/config.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'
import { lieferscheine, sammelrechnungen } from '../../src/db/schema.js'
import { erstelleSammelrechnung } from '../../src/services/lieferschein.service.js'
import {
  fuehreAutoRechnungenDurch, fuehreWartungslaufDurch, gibRechnungenFrei,
} from '../../src/services/wartungsvertrag.service.js'

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

describe('Wartungsrechnungen: Freigabe, Mailversand, Storno (Integration)', () => {
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

  const holeSr = async (vertragId: string) =>
    (await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.wartungsvertragId, vertragId)))

  const freigeben = (ids: string[]) =>
    srv.fastify.inject({ method: 'POST', url: '/api/sammelrechnungen/freigeben', headers: auth(), payload: { ids } })

  /** Vertrag + Lieferschein für Oktober + (bei Mail-Kunden) automatisch erstellte Rechnung */
  async function mailKundeMitRechnung(firma: string, email: string) {
    const kunde   = await neuerKunde({ firma, email, rechnungPerMail: true })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })
    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    const [sr] = await holeSr(vertrag.id)
    return { kunde, vertrag, sr: sr! }
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

  it('Freigabe: die Automatik erstellt die Rechnung, verschickt aber nichts — erst die Freigabe löst Mail und Ausdruck aus', async () => {
    const { vertrag, sr } = await mailKundeMitRechnung('Wirtshaus Auto', 'wirt@auto.at')

    // Erstellt, als offener Posten geführt — aber nichts verschickt, nichts freigegeben
    expect(sr.gesamtbetragCent).toBe(5000)
    expect(sr.freigegebenAm).toBeNull()
    expect(sr.emailVersandtAm).toBeNull()
    expect(sr.emailEmpfaenger).toBe('wirt@auto.at')
    expect(gesendet).toHaveLength(0)
    const op = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as
      Array<{ betragCent: number; notiz?: string }>
    expect(op.some(o => o.betragCent === 5000 && o.notiz?.includes('Wartungsvertrag'))).toBe(true)

    // Ein weiterer Lauf ändert daran nichts (keine zweite Rechnung, weiterhin keine Mail)
    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(await holeSr(vertrag.id)).toHaveLength(1)
    expect(gesendet).toHaveLength(0)

    // Noch nicht freigegeben → nicht in der Ausdruck-Liste
    const vorher = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(vorher.some(r => r.id === sr.id)).toBe(false)

    // Die Übersicht zeigt die Rechnung samt verrechneten Lieferscheinen
    const liste = (await srv.fastify.inject({ method: 'GET', url: '/api/wartungsvertraege/rechnungen', headers: auth() })).json() as
      Array<{ id: string; freigegebenAm?: string; lieferscheine: Array<{ periode?: string; nummer: number }> }>
    const meine = liste.find(r => r.id === sr.id)
    expect(meine?.freigegebenAm).toBeUndefined()
    expect(meine?.lieferscheine.map(l => l.periode)).toEqual(['2026-10'])

    // Freigabe → Mail geht raus (einmal, mit Zahlungsangaben)
    const res = await freigeben([sr.id])
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().abgelehnt).toEqual([])
    expect(res.json().freigegeben[0]).toMatchObject({ id: sr.id, emailEmpfaenger: 'wirt@auto.at' })
    expect(res.json().freigegeben[0].freigegebenAm).toBeTruthy()
    expect(res.json().freigegeben[0].emailVersandtAm).toBeTruthy()
    expect(gesendet).toHaveLength(1)
    expect(gesendet[0]!['to']).toBe('wirt@auto.at')
    const html = String(gesendet[0]!['html'])
    expect(html).toContain('AT611904300234573201')
    expect(html).toContain('Zahlbar bis')

    // Danach steht die Rechnung in der Ausdruck-Liste (1 Exemplar für die Buchhaltung); bestätigen leert sie
    const liste2 = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(liste2.some(r => r.id === sr.id)).toBe(true)
    const gedruckt = await srv.fastify.inject({
      method: 'POST', url: '/api/sammelrechnungen/buchhaltung/gedruckt', headers: auth(), payload: { ids: [sr.id] },
    })
    expect(gedruckt.json()).toEqual({ markiert: 1 })
    const liste3 = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(liste3.some(r => r.id === sr.id)).toBe(false)

    // Zweite Freigabe wird abgewiesen, keine zweite Mail
    const nochmal = await freigeben([sr.id])
    expect(nochmal.json().freigegeben).toEqual([])
    expect(nochmal.json().abgelehnt[0].grund).toContain('freigegeben')
    expect(gesendet).toHaveLength(1)
  })

  it('Mailfehler nach der Freigabe: Fehler wird vermerkt, der nächste Lauf versendet genau einmal nach', async () => {
    const { sr } = await mailKundeMitRechnung('Wirtshaus Retry', 'wirt@retry.at')

    steuerung.fehler = true
    const res = await freigeben([sr.id])
    expect(res.json().freigegeben).toHaveLength(1)
    expect(gesendet).toHaveLength(0)
    const [fehlerhaft] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, sr.id))
    expect(fehlerhaft?.freigegebenAm).not.toBeNull()
    expect(fehlerhaft?.emailVersandtAm).toBeNull()
    expect(fehlerhaft?.emailFehler).toContain('SMTP nicht erreichbar')

    steuerung.fehler = false
    const lauf = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(lauf.erneutVersendet).toBe(1)
    expect(gesendet).toHaveLength(1)
    const [ok] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, sr.id))
    expect(ok?.emailVersandtAm).not.toBeNull()
    expect(ok?.emailFehler).toBeNull()
  })

  it('Kunden ohne Mailversand: Rechnung per Klick, Freigabe ohne Mail, Ausdruck bleibt offen', async () => {
    const kunde = await neuerKunde({ firma: 'Wirtshaus Druck', email: 'wirt@druck.at' })
    const vertrag = await neuerVertrag(kunde.id)
    await fuehreWartungslaufDurch(idb.db, { jetzt: am('2026-10-02'), mandantId })

    // Die Automatik rührt Kunden ohne Mailversand nicht an
    await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(await holeSr(vertrag.id)).toHaveLength(0)

    const res = await srv.fastify.inject({ method: 'POST', url: `/api/wartungsvertraege/${vertrag.id}/abrechnen`, headers: auth() })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().emailEmpfaenger).toBeUndefined()
    expect(res.json().freigegebenAm).toBeUndefined()

    const frei = await freigeben([res.json().id])
    expect(frei.json().freigegeben).toHaveLength(1)
    expect(gesendet).toHaveLength(0)
    const druck = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string; emailEmpfaenger?: string }>
    const eintrag = druck.find(r => r.id === res.json().id)
    expect(eintrag).toBeTruthy()
    expect(eintrag?.emailEmpfaenger).toBeUndefined()   // → am Bildschirm 2 Exemplare: Kunde + Buchhaltung
  })

  it('Mail-Kunde ohne eingerichteten Mailversand lässt sich nicht freigeben', async () => {
    const { sr } = await mailKundeMitRechnung('Wirtshaus OhneSmtp', 'wirt@ohnesmtp.at')
    const res = await gibRechnungenFrei(idb.db, {} as Config, mandantId, [sr.id])
    expect(res.freigegeben).toEqual([])
    expect(res.abgelehnt[0]?.grund).toContain('Mailversand')
    const [danach] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, sr.id))
    expect(danach?.freigegebenAm).toBeNull()
  })

  it('Storno einer versendeten Rechnung: Kunde bekommt automatisch die Stornorechnung, die korrigierte Rechnung geht erst nach Freigabe raus', async () => {
    const { vertrag, sr } = await mailKundeMitRechnung('Wirtshaus Storno', 'wirt@storno.at')
    await freigeben([sr.id])
    expect(gesendet).toHaveLength(1)
    gesendet.length = 0

    const res = await srv.fastify.inject({
      method: 'POST', url: `/api/sammelrechnungen/${sr.id}/stornieren`, headers: auth(), payload: { grund: 'Falscher Betrag' },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ stornoGrund: 'Falscher Betrag', stornoNummer: 1 })
    expect(res.json().storniertAm).toBeTruthy()
    expect(res.json().stornoEmailVersandtAm).toBeTruthy()

    // Storno-Mail: eigene Nummer, Bezug zur Rechnung, negative Beträge — der interne Grund steht nicht darin
    expect(gesendet).toHaveLength(1)
    expect(gesendet[0]!['to']).toBe('wirt@storno.at')
    expect(String(gesendet[0]!['subject'])).toContain('ST-0001')
    expect(String(gesendet[0]!['subject'])).toContain(`SR-${String(sr.nummer).padStart(4, '0')}`)
    const html = String(gesendet[0]!['html'])
    expect(html).toContain('storniert')
    expect(html).toContain('-50,00 €')
    expect(html).not.toContain('Falscher Betrag')

    // Lieferschein wieder offen, offener Posten weg, nicht mehr in der Ausdruck-Liste
    const ls = await idb.db.select().from(lieferscheine).where(eq(lieferscheine.wartungsvertragId, vertrag.id))
    expect(ls.every(l => l.status === 'offen' && l.manuellVerrechnen)).toBe(true)
    const op = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as Array<{ notiz?: string }>
    expect(op.some(o => o.notiz?.includes(`SR-${String(sr.nummer).padStart(4, '0')}`))).toBe(false)
    const buch = (await srv.fastify.inject({ method: 'GET', url: '/api/sammelrechnungen/buchhaltung', headers: auth() })).json() as Array<{ id: string }>
    expect(buch.some(r => r.id === sr.id)).toBe(false)

    // Doppeltes Storno, Freigabe und Ausgabe einer stornierten Rechnung werden abgewiesen
    expect((await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr.id}/stornieren`, headers: auth(), payload: {} })).statusCode).toBe(409)
    expect((await freigeben([sr.id])).json().abgelehnt).toHaveLength(1)
    expect((await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr.id}/email`, headers: auth(), payload: { empfaenger: 'x@y.at' } })).statusCode).toBe(409)

    // Die Automatik rechnet die Lieferscheine NICHT von selbst neu ab
    gesendet.length = 0
    const auto = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(auto.erstellt).toBe(0)
    expect(gesendet).toHaveLength(0)

    // Korrigierte Rechnung: von Hand erstellt → wartet auf Freigabe, kein Mail ohne Freigabe
    const neu = await srv.fastify.inject({ method: 'POST', url: `/api/wartungsvertraege/${vertrag.id}/abrechnen`, headers: auth() })
    expect(neu.statusCode, neu.body).toBe(201)
    expect(neu.json().nummer).toBeGreaterThan(sr.nummer)
    expect(neu.json().storniertAm).toBeUndefined()
    expect(neu.json().freigegebenAm).toBeUndefined()
    expect(gesendet).toHaveLength(0)

    // Nach der Freigabe geht die korrigierte Rechnung in einem eigenen Mail raus
    await freigeben([neu.json().id])
    expect(gesendet).toHaveLength(1)
    expect(String(gesendet[0]!['subject'])).toContain(`SR-${String(neu.json().nummer).padStart(4, '0')}`)
    expect(String(gesendet[0]!['subject'])).not.toContain('Storno')
  })

  it('Storno-Mail: Fehler wird vermerkt und später automatisch wiederholt; unversendete Rechnungen lösen kein Storno-Mail aus', async () => {
    const { sr } = await mailKundeMitRechnung('Wirtshaus StornoRetry', 'wirt@stornoretry.at')
    await freigeben([sr.id])
    gesendet.length = 0

    steuerung.fehler = true
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr.id}/stornieren`, headers: auth(), payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json().stornoEmailVersandtAm).toBeUndefined()
    expect(res.json().stornoEmailFehler).toContain('SMTP nicht erreichbar')

    steuerung.fehler = false
    const lauf = await fuehreAutoRechnungenDurch(idb.db, CONFIG, am('2026-10-02'))
    expect(lauf.erneutVersendet).toBe(1)
    expect(gesendet).toHaveLength(1)
    expect(String(gesendet[0]!['subject'])).toContain('Stornorechnung')

    // Nie verschickt (nicht freigegeben) → auch kein Storno-Mail an den Kunden
    const { sr: unversendet } = await mailKundeMitRechnung('Wirtshaus NieVersendet', 'wirt@nieversendet.at')
    gesendet.length = 0
    const s2 = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${unversendet.id}/stornieren`, headers: auth(), payload: {} })
    expect(s2.statusCode).toBe(200)
    expect(s2.json().stornoNummer).toBe(3)   // lückenlos: ST-0001 und ST-0002 gab es in den Tests davor
    expect(gesendet).toHaveLength(0)
  })

  it('Storno ist mit erfasster Zahlung nicht möglich', async () => {
    const { sr } = await mailKundeMitRechnung('Wirtshaus Gezahlt', 'wirt@gezahlt.at')

    const ops = (await srv.fastify.inject({ method: 'GET', url: '/api/offene-posten', headers: auth() })).json() as Array<{ id: string; notiz?: string }>
    const op  = ops.find(o => o.notiz?.includes(`SR-${String(sr.nummer).padStart(4, '0')}`))
    expect(op).toBeTruthy()
    const zahlung = await srv.fastify.inject({
      method: 'POST', url: `/api/offene-posten/${op!.id}/zahlung`, headers: auth(), payload: { zahlungCent: 1000 },
    })
    expect(zahlung.statusCode, zahlung.body).toBe(200)

    const storno = await srv.fastify.inject({ method: 'POST', url: `/api/sammelrechnungen/${sr.id}/stornieren`, headers: auth(), payload: {} })
    expect(storno.statusCode).toBe(409)
    expect(storno.json().fehler).toContain('Zahlung')
    const [danach] = await idb.db.select().from(sammelrechnungen).where(eq(sammelrechnungen.id, sr.id))
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
