/**
 * Integrationstest (echtes PostgreSQL, Migration 0079): Einkaufsbestellungen — Bestellung beim Lieferanten.
 * Nummernvergabe, Entwurf bearbeiten, Statusfolge, Löschen, Mandantentrennung, Berechtigung, Bestell-PDF
 * und Versand per Mail (nodemailer abgefangen, geprüft wird die tatsächlich gebaute Mail inkl. PDF-Anhang).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer, TEST_SETUP_TOKEN } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const { gesendet } = vi.hoisted(() => ({ gesendet: [] as Array<Record<string, unknown>> }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: Record<string, unknown>) => {
        if (String(mail['to']).includes('kaputt')) throw new Error('Mailserver lehnt ab')
        gesendet.push(mail)
        return { messageId: 'test' }
      },
    }),
  },
}))

const SMTP = { SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'kassa@test.at' }
const PASSWORT = 'einkauf-bestellung-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

function setupInput(nr: 1 | 2) {
  return {
    firmenname: `Einkauf ${nr} GmbH`,
    uid:        `ATU9999996${nr}`,
    kassenId:   `EK-00${nr}`,
    finanzOnline: { teilnehmerId: `TID-EK-${nr}`, benutzerkennung: `BID-EK-${nr}`, pin: `PIN-EK-${nr}` },
    umgebung: 'test',
    admin: { name: `EK Admin ${nr}`, email: `admin${nr}@einkauf.at`, passwort: PASSWORT },
  }
}

interface Pos { id: string; position: number; bezeichnung: string; menge: number; einkaufspreisCent: number | null; gelieferteMenge: number; artikelId: string | null; lieferantenArtikelnummer: string | null }
interface Bestellung {
  id: string; nummer: string; status: string; lieferantId: string; lieferantName: string; bemerkung: string | null
  liefertermin: string | null; gesendetAn: string | null; gesendetAm: string | null
  positionen: Pos[]; summeNettoCent: number; summeUnvollstaendig: boolean
}

describe('Einkaufsbestellungen (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let tokenA = '', tokenB = '', tokenKellner = ''
  let lieferantA = '', lieferantAOhneMail = '', lieferantB = '', artikelA = '', artikelB = ''

  const authA = () => ({ authorization: `Bearer ${tokenA}` })
  const authB = () => ({ authorization: `Bearer ${tokenB}` })
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: { authorization: string }, payload?: unknown) =>
    srv.fastify.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) })

  const jahr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric' }).format(new Date())

  const anlegen = async (positionen: unknown[] = [{ bezeichnung: 'Toner schwarz', menge: 2, einkaufspreisCent: 4500 }], extra: Record<string, unknown> = {}) => {
    const res = await inject('POST', '/api/einkauf/bestellungen', authA(), { lieferantId: lieferantA, positionen, ...extra })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as Bestellung
  }

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient(), config: SMTP })
    for (const nr of [1, 2] as const) {
      const s = await srv.fastify.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-token': TEST_SETUP_TOKEN }, payload: setupInput(nr) })
      if (s.statusCode !== 201) throw new Error(`Setup ${nr} (${s.statusCode}): ${s.body}`)
      const l = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `admin${nr}@einkauf.at`, passwort: PASSWORT } })
      if (l.statusCode !== 200) throw new Error(`Login ${nr} (${l.statusCode}): ${l.body}`)
      if (nr === 1) tokenA = l.json().token; else tokenB = l.json().token
    }
    const k = await inject('POST', '/api/users', authA(), { name: 'Kellner', email: 'kellner@einkauf.at', passwort: PASSWORT, rolle: 'kellner', berechtigungen: ['kasse'], kassenIds: [] })
    if (k.statusCode !== 201) throw new Error(`Kellner (${k.statusCode}): ${k.body}`)
    const kl = await srv.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kellner@einkauf.at', passwort: PASSWORT } })
    tokenKellner = kl.json().token

    lieferantA = (await inject('POST', '/api/lieferanten', authA(), {
      name: 'Kosatec', email: 'bestellung@kosatec.de', strasse: 'Carl-Miele-Straße 3', plz: '38112', ort: 'Braunschweig', land: 'DE',
      kundennummer: 'K-1', zahlungsbedingung: '14 Tage netto',
    })).json().id
    lieferantAOhneMail = (await inject('POST', '/api/lieferanten', authA(), { name: 'Ohne Mail' })).json().id
    lieferantB = (await inject('POST', '/api/lieferanten', authB(), { name: 'Fremd' })).json().id
    artikelA = (await inject('POST', '/api/artikel', authA(), { bezeichnung: 'Artikel A', preisBruttoCent: 100, mwstSatz: 'normal' })).json().id
    artikelB = (await inject('POST', '/api/artikel', authB(), { bezeichnung: 'Artikel B', preisBruttoCent: 100, mwstSatz: 'normal' })).json().id
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  beforeEach(() => { gesendet.length = 0 })

  it('legt einen Entwurf mit fortlaufender Nummer, Positionen und Summe an', async () => {
    const a = await anlegen([
      { artikelId: artikelA, bezeichnung: 'Toner schwarz', lieferantenArtikelnummer: 'TN-227', menge: 2, einkaufspreisCent: 4500 },
      { bezeichnung: 'Kabel', menge: 10, einkaufspreisCent: 150 },
    ], { bemerkung: 'Bitte bis Freitag', liefertermin: '2026-12-31' })
    expect(a.nummer).toMatch(new RegExp(`^B${jahr}\\d{3}$`))
    expect(a).toMatchObject({ status: 'entwurf', lieferantName: 'Kosatec', bemerkung: 'Bitte bis Freitag', liefertermin: '2026-12-31', summeNettoCent: 10500, summeUnvollstaendig: false })
    expect(a.positionen.map(p => [p.position, p.bezeichnung, p.menge, p.gelieferteMenge])).toEqual([[1, 'Toner schwarz', 2, 0], [2, 'Kabel', 10, 0]])
    expect(a.positionen[0]).toMatchObject({ artikelId: artikelA, lieferantenArtikelnummer: 'TN-227' })

    const b = await anlegen()
    expect(Number(b.nummer.slice(-3))).toBe(Number(a.nummer.slice(-3)) + 1)
  })

  it('Position ohne Preis: Summe wird als unvollständig gekennzeichnet', async () => {
    const a = await anlegen([{ bezeichnung: 'Mit Preis', menge: 1, einkaufspreisCent: 1000 }, { bezeichnung: 'Ohne Preis', menge: 3 }])
    expect(a).toMatchObject({ summeNettoCent: 1000, summeUnvollstaendig: true })
  })

  it('lehnt ungültige Eingaben ab (keine Position, Menge 0, Termin-Format) und unbekannte Bezüge', async () => {
    const post = (payload: unknown) => inject('POST', '/api/einkauf/bestellungen', authA(), payload)
    expect((await post({ lieferantId: lieferantA, positionen: [] })).statusCode).toBe(400)
    expect((await post({ lieferantId: lieferantA, positionen: [{ bezeichnung: 'X', menge: 0 }] })).statusCode).toBe(400)
    expect((await post({ lieferantId: lieferantA, liefertermin: '31.12.2026', positionen: [{ bezeichnung: 'X', menge: 1 }] })).statusCode).toBe(400)
    // fremder Lieferant / fremder Artikel (Mandant B) → 404, nichts wird angelegt
    expect((await post({ lieferantId: lieferantB, positionen: [{ bezeichnung: 'X', menge: 1 }] })).statusCode).toBe(404)
    expect((await post({ lieferantId: lieferantA, positionen: [{ artikelId: artikelB, bezeichnung: 'X', menge: 1 }] })).statusCode).toBe(404)
  })

  it('Entwurf bearbeiten ersetzt die Positionen (neu durchnummeriert); danach ist er gesperrt', async () => {
    const a = await anlegen([{ bezeichnung: 'Alt 1', menge: 1 }, { bezeichnung: 'Alt 2', menge: 1 }])
    const put = await inject('PUT', `/api/einkauf/bestellungen/${a.id}`, authA(), {
      bemerkung: 'Geändert', liefertermin: '2027-01-15', positionen: [{ bezeichnung: 'Neu', menge: 5, einkaufspreisCent: 200 }],
    })
    expect(put.statusCode, put.body).toBe(200)
    const b = put.json() as Bestellung
    expect(b).toMatchObject({ bemerkung: 'Geändert', liefertermin: '2027-01-15', summeNettoCent: 1000 })
    expect(b.positionen.map(p => [p.position, p.bezeichnung])).toEqual([[1, 'Neu']])

    // nur Bemerkung ändern lässt die Positionen unverändert
    const nurText = await inject('PUT', `/api/einkauf/bestellungen/${a.id}`, authA(), { bemerkung: null })
    expect((nurText.json() as Bestellung).positionen).toHaveLength(1)

    await inject('POST', `/api/einkauf/bestellungen/${a.id}/status`, authA(), { status: 'gesendet', gesendetAn: 'telefonisch' })
    expect((await inject('PUT', `/api/einkauf/bestellungen/${a.id}`, authA(), { bemerkung: 'zu spät' })).statusCode).toBe(409)
  })

  it('Statusfolge: entwurf → gesendet → erledigt; unzulässige Wechsel und „teilgeliefert" von Hand → 409', async () => {
    const a = await anlegen()
    const status = (id: string, s: string, extra: Record<string, unknown> = {}) => inject('POST', `/api/einkauf/bestellungen/${id}/status`, authA(), { status: s, ...extra })

    expect((await status(a.id, 'erledigt')).statusCode).toBe(409)       // Entwurf kann nicht gleich erledigt sein
    expect((await status(a.id, 'teilgeliefert')).statusCode).toBe(409)  // setzt nur der Wareneingang
    const g = await status(a.id, 'gesendet', { gesendetAn: 'Bestellportal' })
    expect(g.statusCode).toBe(200)
    expect(g.json()).toMatchObject({ status: 'gesendet', gesendetAn: 'Bestellportal' })
    expect((g.json() as Bestellung).gesendetAm).not.toBeNull()
    const e = await status(a.id, 'erledigt')
    expect(e.json()).toMatchObject({ status: 'erledigt' })
    expect((await status(a.id, 'storniert')).statusCode).toBe(409)      // erledigt ist endgültig
    expect((await status(a.id, 'gesendet')).statusCode).toBe(409)

    const s = await anlegen()
    expect((await status(s.id, 'storniert')).json()).toMatchObject({ status: 'storniert' })
    expect((await status(s.id, 'gesendet')).statusCode).toBe(409)
  })

  it('Löschen geht nur im Entwurf', async () => {
    const a = await anlegen()
    expect((await inject('DELETE', `/api/einkauf/bestellungen/${a.id}`, authA())).statusCode).toBe(204)
    expect((await inject('GET', `/api/einkauf/bestellungen/${a.id}`, authA())).statusCode).toBe(404)

    const b = await anlegen()
    await inject('POST', `/api/einkauf/bestellungen/${b.id}/status`, authA(), { status: 'gesendet' })
    expect((await inject('DELETE', `/api/einkauf/bestellungen/${b.id}`, authA())).statusCode).toBe(409)
  })

  it('Liste: filtert nach Status und Lieferant, neueste zuerst, mit Anzahl der Positionen', async () => {
    const x = await anlegen([{ bezeichnung: 'A', menge: 1 }, { bezeichnung: 'B', menge: 1 }, { bezeichnung: 'C', menge: 1 }])
    const alle = (await inject('GET', '/api/einkauf/bestellungen', authA())).json() as (Bestellung & { anzahlPositionen: number })[]
    expect(alle.find(b => b.id === x.id)).toMatchObject({ anzahlPositionen: 3, lieferantName: 'Kosatec' })
    expect('positionen' in alle[0]!).toBe(false)
    const nurSent = (await inject('GET', '/api/einkauf/bestellungen?status=gesendet', authA())).json() as Bestellung[]
    expect(nurSent.every(b => b.status === 'gesendet')).toBe(true)
    expect(nurSent.find(b => b.id === x.id)).toBeUndefined()
    const lieferant2 = (await inject('GET', `/api/einkauf/bestellungen?lieferantId=${lieferantAOhneMail}`, authA())).json() as Bestellung[]
    expect(lieferant2).toEqual([])
    expect((await inject('GET', '/api/einkauf/bestellungen?status=kaputt', authA())).statusCode).toBe(400)
  })

  it('Mandantentrennung: Mandant B sieht und ändert nichts von Mandant A', async () => {
    const a = await anlegen()
    expect(((await inject('GET', '/api/einkauf/bestellungen', authB())).json() as Bestellung[]).find(b => b.id === a.id)).toBeUndefined()
    for (const [m, u] of [['GET', ''], ['GET', '/pdf']] as const) {
      expect((await inject(m, `/api/einkauf/bestellungen/${a.id}${u}`, authB())).statusCode, u).toBe(404)
    }
    expect((await inject('PUT', `/api/einkauf/bestellungen/${a.id}`, authB(), { bemerkung: 'x' })).statusCode).toBe(404)
    expect((await inject('DELETE', `/api/einkauf/bestellungen/${a.id}`, authB())).statusCode).toBe(404)
    expect((await inject('POST', `/api/einkauf/bestellungen/${a.id}/status`, authB(), { status: 'storniert' })).statusCode).toBe(404)
    expect((await inject('POST', `/api/einkauf/bestellungen/${a.id}/email`, authB(), {})).statusCode).toBe(404)
    // unverändert
    expect((await inject('GET', `/api/einkauf/bestellungen/${a.id}`, authA())).json()).toMatchObject({ status: 'entwurf', bemerkung: null })
  })

  it('ohne Berechtigung „artikel.verwalten" (Kellner) → 403 auf allen Wegen', async () => {
    const a = await anlegen()
    const k = { authorization: `Bearer ${tokenKellner}` }
    expect((await inject('GET', '/api/einkauf/bestellungen', k)).statusCode).toBe(403)
    expect((await inject('POST', '/api/einkauf/bestellungen', k, { lieferantId: lieferantA, positionen: [{ bezeichnung: 'X', menge: 1 }] })).statusCode).toBe(403)
    expect((await inject('GET', `/api/einkauf/bestellungen/${a.id}`, k)).statusCode).toBe(403)
    expect((await inject('GET', `/api/einkauf/bestellungen/${a.id}/pdf`, k)).statusCode).toBe(403)
    expect((await inject('POST', `/api/einkauf/bestellungen/${a.id}/status`, k, { status: 'gesendet' })).statusCode).toBe(403)
    expect((await inject('POST', `/api/einkauf/bestellungen/${a.id}/email`, k, {})).statusCode).toBe(403)
  })

  it('Bestell-PDF: echtes PDF mit Nummer; viele Positionen laufen über mehrere Seiten', async () => {
    const klein = await anlegen([{ bezeichnung: 'Toner schwarz', menge: 2, einkaufspreisCent: 4500 }])
    const res = await inject('GET', `/api/einkauf/bestellungen/${klein.id}/pdf`, authA())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(String(res.headers['content-disposition'])).toContain(`Bestellung-${klein.nummer}.pdf`)
    const bytes = res.rawPayload
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1500)

    const viele = await anlegen(Array.from({ length: 70 }, (_, i) => ({ bezeichnung: `Artikel mit langer Bezeichnung Nummer ${i + 1}`, lieferantenArtikelnummer: `ART-${i + 1}`, menge: i + 1, einkaufspreisCent: 100 + i })))
    const gross = (await inject('GET', `/api/einkauf/bestellungen/${viele.id}/pdf`, authA())).rawPayload
    const seiten = (gross.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
    expect(seiten).toBeGreaterThanOrEqual(2)
  })

  it('E-Mail: Mail geht mit PDF-Anhang an die Adresse des Lieferanten, erst danach „gesendet"', async () => {
    const a = await anlegen([{ bezeichnung: 'Toner <b>schwarz</b>', menge: 2, einkaufspreisCent: 4500 }], { bemerkung: 'Bitte <script>x</script> liefern', liefertermin: '2026-12-31' })
    const res = await inject('POST', `/api/einkauf/bestellungen/${a.id}/email`, authA(), {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ status: 'gesendet', gesendetAn: 'bestellung@kosatec.de' })

    expect(gesendet).toHaveLength(1)
    const mail = gesendet[0]!
    expect(mail['to']).toBe('bestellung@kosatec.de')
    expect(String(mail['subject'])).toContain(a.nummer)
    expect(String(mail['html'])).not.toContain('<script>')           // Eingaben maskiert
    expect(String(mail['html'])).toContain('31.12.2026')
    const anhang = (mail['attachments'] as { filename: string; content: Buffer; contentType: string }[])[0]!
    expect(anhang).toMatchObject({ filename: `Bestellung-${a.nummer}.pdf`, contentType: 'application/pdf' })
    expect(anhang.content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('E-Mail: eigene Adresse überschreibt; ohne Adresse → 409; Mailserver-Fehler lässt den Status unverändert', async () => {
    const ohne = (await inject('POST', '/api/einkauf/bestellungen', authA(), { lieferantId: lieferantAOhneMail, positionen: [{ bezeichnung: 'X', menge: 1 }] })).json() as Bestellung
    const r1 = await inject('POST', `/api/einkauf/bestellungen/${ohne.id}/email`, authA(), {})
    expect(r1.statusCode).toBe(409)
    expect(gesendet).toHaveLength(0)
    const r2 = await inject('POST', `/api/einkauf/bestellungen/${ohne.id}/email`, authA(), { empfaenger: 'einkauf@lieferant.at' })
    expect(r2.statusCode).toBe(200)
    expect(gesendet[0]!['to']).toBe('einkauf@lieferant.at')

    const b = await anlegen()
    const r3 = await inject('POST', `/api/einkauf/bestellungen/${b.id}/email`, authA(), { empfaenger: 'kaputt@lieferant.at' })
    expect(r3.statusCode).toBe(502)
    expect((await inject('GET', `/api/einkauf/bestellungen/${b.id}`, authA())).json()).toMatchObject({ status: 'entwurf', gesendetAn: null })

    expect((await inject('POST', `/api/einkauf/bestellungen/${b.id}/email`, authA(), { empfaenger: 'keine-mail' })).statusCode).toBe(400)
  })

  it('E-Mail: eine stornierte oder erledigte Bestellung wird nicht mehr versendet; erneutes Senden einer gesendeten ist erlaubt', async () => {
    const s = await anlegen()
    await inject('POST', `/api/einkauf/bestellungen/${s.id}/status`, authA(), { status: 'storniert' })
    expect((await inject('POST', `/api/einkauf/bestellungen/${s.id}/email`, authA(), {})).statusCode).toBe(409)

    const g = await anlegen()
    expect((await inject('POST', `/api/einkauf/bestellungen/${g.id}/email`, authA(), {})).statusCode).toBe(200)
    expect((await inject('POST', `/api/einkauf/bestellungen/${g.id}/email`, authA(), {})).statusCode).toBe(200)
    expect(gesendet).toHaveLength(2)
  })
})
