/**
 * Integrationstest des Portals gegen echtes PostgreSQL: Anmeldung mit TOTP, Betriebe und Boxen, Empfang der Meldungen,
 * Bewertung in der Übersicht, Fehler-Zusammenzählung.
 *
 * Die Uhr ist steuerbar (`uhr`), damit Sperrzeiten, TOTP-Schritte und „offline" ohne Warten prüfbar sind.
 */

import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { BoxDetail, BoxMitToken, PortalMeldung, Uebersicht } from '@kassa/shared'
import { loadConfig } from '../../src/config.js'
import { buildServer } from '../../src/server.js'
import { portalBenutzer, portalBoxen, portalFehler } from '../../src/db/schema.js'
import { base32Dekodiere, hotp, totpSchritt } from '../../src/auth/totp.js'
import { legeBenutzerAn } from '../../src/services/benutzer.service.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const EMAIL = 'chef@kassa.at'
const PASSWORT = 'ein-sehr-gutes-passwort-42'
const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let uhr = new Date('2026-11-27T12:00:00.000Z')
const jetzt = () => uhr
const vorruecken = (sekunden: number) => { uhr = new Date(uhr.getTime() + sekunden * 1000) }
const vor = (sekunden: number) => new Date(uhr.getTime() - sekunden * 1000).toISOString()

const config = loadConfig({
  DATABASE_URL: 'postgresql://unbenutzt:unbenutzt@localhost:5432/unbenutzt',
  PORTAL_JWT_SECRET: 'j'.repeat(40),
  PORTAL_MASTER_KEY: 'm'.repeat(40),
  NODE_ENV: 'test',
})

/** Eine gesunde Meldung einer Box; Teile lassen sich überschreiben. */
function meldung(o: Partial<PortalMeldung> = {}): PortalMeldung {
  return {
    schema: 1, gesendetAm: uhr.toISOString(), version: '0.8.100', uptimeSek: 3600,
    db: { ok: true, latenzMs: 3 },
    backups: {
      dbBackup:  { letzteSicherung: uhr.toISOString(), alterStunden: 2, zustand: 'ok' },
      depBackup: { letzteSicherung: uhr.toISOString(), alterStunden: 2, zustand: 'ok' },
    },
    speicher: { zustand: 'ok', gesamtGb: 100, freiGb: 60, freiProzent: 60 },
    betriebe: [{
      id: G(1), firmenname: 'Gasthaus Zur Post', status: 'aktiv',
      kassen: [{ id: G(2), kassenId: 'K-001', bezeichnung: null, status: 'aktiv', umgebung: 'produktion', seeTyp: 'software', seeAusgefallenSeit: null, seeGueltigBis: new Date(uhr.getTime() + 400 * 86_400_000).toISOString(), offeneBonProbleme: 0 }],
      drucker: [{ quelle: 'bonier', name: 'Küche', erreichbar: true, geprueftAm: uhr.toISOString(), fehler: null }],
    }],
    fehler: [],
    ...o,
  }
}

const fehler = (hash: string, anzahl: number, ersterAm: string, letzterAm: string, text = 'Verbindung verloren') =>
  ({ hash, name: 'Error', meldung: text, route: '/api/belege', mandantId: null, anzahl, ersterAm, letzterAm })

describe('Serviceportal (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let server: FastifyInstance
  let sitzung = ''

  const anfrage = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, token?: string) =>
    server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) })
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => anfrage(method, url, body, sitzung)
  const codeJetzt = (secret: string) => hotp(base32Dekodiere(secret), totpSchritt(uhr.getTime()))

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    server = await buildServer({ config, db: idb.db, jetzt })
    await server.ready()
  })

  afterAll(async () => { await server?.close(); await idb?.zerstoeren() })

  // =========================================================================
  describe('Anmeldung', () => {
    let secret = ''

    it('Benutzer anlegen: Passwortregeln und Dublette', async () => {
      await expect(legeBenutzerAn(idb.db, EMAIL, 'kurz')).rejects.toThrow(/mindestens 12/)
      await expect(legeBenutzerAn(idb.db, 'keine-adresse', PASSWORT)).rejects.toThrow(/E-Mail/)
      await legeBenutzerAn(idb.db, EMAIL, PASSWORT)
      await expect(legeBenutzerAn(idb.db, '  CHEF@kassa.AT ', PASSWORT)).rejects.toThrow(/schon einen Benutzer/)
    })

    it('falsches Passwort und unbekannte E-Mail: dieselbe Antwort', async () => {
      const falsch = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL, passwort: 'falsches-passwort-123' })
      const unbekannt = await anfrage('POST', '/api/auth/anmelden', { email: 'niemand@kassa.at', passwort: PASSWORT })
      expect(falsch.statusCode).toBe(401)
      expect(unbekannt.statusCode).toBe(401)
      expect(unbekannt.json()).toEqual(falsch.json())
    })

    it('ungültige Eingaben → 400', async () => {
      expect((await anfrage('POST', '/api/auth/anmelden', {})).statusCode).toBe(400)
      expect((await anfrage('POST', '/api/auth/anmelden', { email: 'x', passwort: 'y' })).statusCode).toBe(400)
    })

    it('Erstanmeldung: Einrichtung der Authenticator-App steht an; das Einrichtungs-Token ist KEINE Sitzung', async () => {
      const r = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL.toUpperCase(), passwort: PASSWORT })
      expect(r.statusCode).toBe(200)
      expect(r.json().status).toBe('totp_einrichten')
      const setup = r.json().einrichtungsToken as string

      expect((await anfrage('GET', '/api/uebersicht', undefined, setup)).statusCode).toBe(401)
      expect((await anfrage('GET', '/api/ich', undefined, setup)).statusCode).toBe(401)

      const e = await anfrage('POST', '/api/auth/totp/einrichten', undefined, setup)
      expect(e.statusCode).toBe(200)
      secret = e.json().secret
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      expect(e.json().otpauthUrl).toContain('otpauth://totp/')

      // In der Datenbank steht das Geheimnis nur verschlüsselt und noch nicht aktiv
      const [b] = await idb.db.select().from(portalBenutzer).where(eq(portalBenutzer.email, EMAIL))
      expect(b!.totpAktiv).toBe(false)
      expect(b!.totpGeheimnis).toBeTruthy()
      expect(b!.totpGeheimnis).not.toContain(secret)

      const falsch = await anfrage('POST', '/api/auth/totp/bestaetigen', { code: '000000' }, setup)
      expect(falsch.statusCode).toBe(400)
      expect((await anfrage('POST', '/api/auth/totp/bestaetigen', { code: 'abc' }, setup)).statusCode).toBe(400)

      const ok = await anfrage('POST', '/api/auth/totp/bestaetigen', { code: codeJetzt(secret) }, setup)
      expect(ok.statusCode).toBe(200)
      expect(ok.json().status).toBe('angemeldet')
      sitzung = ok.json().token

      const ich = await admin('GET', '/api/ich')
      expect(ich.json()).toMatchObject({ email: EMAIL })
    })

    it('Eine eingerichtete Authenticator-App lässt sich nicht noch einmal einrichten', async () => {
      const r = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL, passwort: PASSWORT })
      expect(r.statusCode).toBe(401) // jetzt wird ein Code verlangt
      expect(r.json().code).toBe('code_erforderlich')
    })

    it('Folgeanmeldung: Passwort + Code; derselbe Code gilt kein zweites Mal', async () => {
      vorruecken(30) // nächster Schritt — der Code der Einrichtung ist verbraucht
      const code = codeJetzt(secret)
      const ok = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL, passwort: PASSWORT, code })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().status).toBe('angemeldet')

      const nochmal = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL, passwort: PASSWORT, code })
      expect(nochmal.statusCode).toBe(401)
      expect(nochmal.json().code).toBeUndefined()
    })

    it('falscher Code: wie falsches Passwort', async () => {
      vorruecken(60)
      const r = await anfrage('POST', '/api/auth/anmelden', { email: EMAIL, passwort: PASSWORT, code: '000000' })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBeUndefined()
      // Zähler zurücksetzen, damit die Sperre-Prüfung unten nicht von diesem Versuch abhängt
      await idb.db.update(portalBenutzer).set({ fehlversuche: 0 }).where(eq(portalBenutzer.email, EMAIL))
    })

    it('nach 5 Fehlversuchen ist das Konto gesperrt — auch das richtige Passwort hilft dann nicht, bis die Zeit um ist', async () => {
      await legeBenutzerAn(idb.db, 'sperre@kassa.at', PASSWORT)
      for (let i = 0; i < 5; i++) {
        expect((await anfrage('POST', '/api/auth/anmelden', { email: 'sperre@kassa.at', passwort: 'falsch-falsch-falsch' })).statusCode).toBe(401)
      }
      const gesperrt = await anfrage('POST', '/api/auth/anmelden', { email: 'sperre@kassa.at', passwort: PASSWORT })
      expect(gesperrt.statusCode).toBe(401)

      vorruecken(14 * 60)
      expect((await anfrage('POST', '/api/auth/anmelden', { email: 'sperre@kassa.at', passwort: PASSWORT })).statusCode).toBe(401)
      vorruecken(2 * 60)
      const frei = await anfrage('POST', '/api/auth/anmelden', { email: 'sperre@kassa.at', passwort: PASSWORT })
      expect(frei.statusCode).toBe(200)
    })

    it('ein deaktivierter Benutzer verliert seine Sitzung sofort', async () => {
      expect((await admin('GET', '/api/ich')).statusCode).toBe(200)
      await idb.db.update(portalBenutzer).set({ aktiv: false }).where(eq(portalBenutzer.email, EMAIL))
      expect((await admin('GET', '/api/ich')).statusCode).toBe(401)
      await idb.db.update(portalBenutzer).set({ aktiv: true }).where(eq(portalBenutzer.email, EMAIL))
      expect((await admin('GET', '/api/ich')).statusCode).toBe(200)
    })

    it('Sitzungs-Token ohne Anmeldung, kaputt oder fremd signiert → 401', async () => {
      for (const t of [undefined, 'kein.jwt.token', sitzung.slice(0, -4) + 'xxxx']) {
        expect((await anfrage('GET', '/api/uebersicht', undefined, t)).statusCode).toBe(401)
      }
    })
  })

  // =========================================================================
  describe('Betriebe und Boxen', () => {
    let betriebId = ''
    let box: BoxMitToken

    it('Betrieb anlegen; Dublette → 409; ungültig → 400', async () => {
      const r = await admin('POST', '/api/betriebe', { name: 'Gasthaus Zur Post', notiz: 'Stammkunde' })
      expect(r.statusCode).toBe(201)
      betriebId = r.json().id
      expect((await admin('POST', '/api/betriebe', { name: 'Gasthaus Zur Post' })).statusCode).toBe(409)
      expect((await admin('POST', '/api/betriebe', { name: '   ' })).statusCode).toBe(400)
      expect((await admin('POST', '/api/betriebe', {})).statusCode).toBe(400)
    })

    it('Module vermerken: nur bekannte Module, ohne Doppelte', async () => {
      expect((await admin('PATCH', `/api/betriebe/${betriebId}`, { module: ['sprache', 'quartalsSicherung', 'sprache'] })).statusCode).toBe(204)
      expect((await admin('PATCH', `/api/betriebe/${betriebId}`, { module: ['gibt-es-nicht'] })).statusCode).toBe(400)
      expect((await admin('PATCH', '/api/betriebe/keine-id', { name: 'x' })).statusCode).toBe(400)
      expect((await admin('PATCH', `/api/betriebe/${G(77)}`, { name: 'x' })).statusCode).toBe(404)
      const u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.module).toEqual(['sprache', 'quartalsSicherung'])
    })

    it('Box anlegen: Token einmalig, in der Datenbank nur der Hash', async () => {
      const r = await admin('POST', `/api/betriebe/${betriebId}/boxen`, { name: 'Hauptkassa' })
      expect(r.statusCode).toBe(201)
      box = r.json()
      expect(box.token).toMatch(/^kpt_[A-Za-z0-9_-]{43}$/)
      expect(box.box).toMatchObject({ name: 'Hauptkassa', status: 'neu', aktiv: true, zuletztGesehen: null })

      const [zeile] = await idb.db.select().from(portalBoxen).where(eq(portalBoxen.id, box.box.id))
      expect(zeile!.tokenHash).toBe(createHash('sha256').update(box.token).digest('hex'))
      expect(JSON.stringify(zeile)).not.toContain(box.token)
      expect(zeile!.tokenHinweis).toBe(box.token.slice(-4))

      expect((await admin('POST', `/api/betriebe/${G(77)}/boxen`, { name: 'x' })).statusCode).toBe(404)
      expect((await admin('POST', `/api/betriebe/${betriebId}/boxen`, {})).statusCode).toBe(400)
    })

    it('Übersicht: neue Box → Status „neu"', async () => {
      const u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe).toHaveLength(1)
      expect(u.betriebe[0]).toMatchObject({ name: 'Gasthaus Zur Post', status: 'neu', notiz: 'Stammkunde' })
      expect(u.zusammenfassung).toEqual({ boxen: 1, ok: 0, warnung: 0, kritisch: 0, offline: 0, neu: 1 })
    })

    // ---- Empfang ----
    it('Meldung ohne oder mit falschem Token → 401, immer dieselbe Antwort', async () => {
      const kandidaten = [undefined, 'kein-token', `kpt_${'a'.repeat(43)}`, box.token.slice(0, -1), `Basic ${box.token}`]
      const antworten = []
      for (const k of kandidaten) {
        const r = await server.inject({ method: 'POST', url: '/api/box/meldung', payload: meldung(), ...(k ? { headers: { authorization: k.startsWith('Basic') ? k : `Bearer ${k}` } } : {}) })
        expect(r.statusCode).toBe(401)
        antworten.push(r.body)
      }
      expect(new Set(antworten).size).toBe(1)
    })

    it('gültige Meldung wird angenommen; Übersicht zeigt „ok" mit Version und Zeitpunkt', async () => {
      const r = await anfrage('POST', '/api/box/meldung', meldung(), box.token)
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ ok: true })

      const u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.status).toBe('ok')
      expect(u.betriebe[0]!.boxen[0]).toMatchObject({ status: 'ok', version: '0.8.100', gruende: [], zuletztGesehen: uhr.toISOString() })
      expect(u.zusammenfassung).toMatchObject({ boxen: 1, ok: 1, neu: 0 })
    })

    it('ungültige Meldung → 400 mit Hinweis; unbekannte Zusatzfelder und Fremddaten kommen nicht in die Datenbank', async () => {
      const kaputt = await anfrage('POST', '/api/box/meldung', { ...meldung(), schema: 2 }, box.token)
      expect(kaputt.statusCode).toBe(400)
      expect(kaputt.json().details.length).toBeGreaterThan(0)
      expect((await anfrage('POST', '/api/box/meldung', { hallo: 'welt' }, box.token)).statusCode).toBe(400)

      // Ein Zusatzfeld (z. B. Umsatz) wird nicht gespeichert — das Schema ist die Grenze
      const mitUmsatz = { ...meldung(), umsatzHeute: 1234.5 }
      expect((await anfrage('POST', '/api/box/meldung', mitUmsatz, box.token)).statusCode).toBe(200)
      const [zeile] = await idb.db.select().from(portalBoxen).where(eq(portalBoxen.id, box.box.id))
      expect(JSON.stringify(zeile!.meldung)).not.toContain('umsatz')
    })

    it('Probleme der Box erscheinen als Gründe: Drucker weg → Warnung; Datenbank weg → kritisch', async () => {
      const m = meldung()
      m.betriebe[0]!.drucker[0] = { quelle: 'bonier', name: 'Küche', erreichbar: false, geprueftAm: uhr.toISOString(), fehler: 'Zeitüberschreitung' }
      await anfrage('POST', '/api/box/meldung', m, box.token)
      let u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.boxen[0]).toMatchObject({ status: 'warnung' })
      expect(u.betriebe[0]!.boxen[0]!.gruende[0]).toMatchObject({ stufe: 'warnung', code: 'drucker' })

      await anfrage('POST', '/api/box/meldung', meldung({ db: { ok: false, latenzMs: null } }), box.token)
      u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.status).toBe('kritisch')
      expect(u.zusammenfassung).toMatchObject({ kritisch: 1, ok: 0 })

      await anfrage('POST', '/api/box/meldung', meldung(), box.token) // wieder gesund
    })

    it('Fehlerberichte werden je Gruppe zusammengezählt: Anzahl addiert, erstes/letztes Datum, jüngster Text', async () => {
      await anfrage('POST', '/api/box/meldung', meldung({ fehler: [fehler('h1', 3, vor(3600), vor(3000), 'alter Text'), fehler('h2', 1, vor(500), vor(500), 'Anderes')] }), box.token)
      vorruecken(60)
      await anfrage('POST', '/api/box/meldung', meldung({ fehler: [fehler('h1', 2, vor(200), vor(100), 'neuer Text')] }), box.token)

      const d = (await admin('GET', `/api/boxen/${box.box.id}`)).json() as BoxDetail
      const h1 = d.fehler.find(f => f.hash === 'h1')!
      expect(h1).toMatchObject({ anzahl: 5, meldung: 'neuer Text' })
      expect(h1.ersterAm).toBe(vor(3600 + 60)) // das ältere der beiden
      expect(h1.letzterAm).toBe(vor(100))      // das jüngere der beiden
      expect(d.fehler.find(f => f.hash === 'h2')!.anzahl).toBe(1)
      expect(d.fehler.map(f => f.hash)).toEqual(['h1', 'h2']) // neueste zuerst
    })

    it('Fehlergruppen, die länger als 90 Tage zurückliegen, werden aufgeräumt', async () => {
      await anfrage('POST', '/api/box/meldung', meldung({ fehler: [fehler('alt', 4, vor(120 * 86_400), vor(100 * 86_400))] }), box.token)
      const zeilen = await idb.db.select().from(portalFehler).where(eq(portalFehler.boxId, box.box.id))
      expect(zeilen.map(z => z.hash)).not.toContain('alt')
    })

    it('Box-Detail: letzte Meldung, Betrieb, Token-Hinweis; unbekannte Box → 404', async () => {
      const d = (await admin('GET', `/api/boxen/${box.box.id}`)).json() as BoxDetail
      expect(d).toMatchObject({ betriebName: 'Gasthaus Zur Post', betriebId, tokenHinweis: box.token.slice(-4) })
      expect(d.meldung!.version).toBe('0.8.100')
      expect(d.meldung!.betriebe[0]!.firmenname).toBe('Gasthaus Zur Post')
      expect((await admin('GET', `/api/boxen/${G(77)}`)).statusCode).toBe(404)
      expect((await admin('GET', '/api/boxen/keine-id')).statusCode).toBe(400)
    })

    it('Offline: nach 10 Minuten ohne Meldung; eine neue Meldung holt die Box zurück', async () => {
      vorruecken(10 * 60 + 1)
      let u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.boxen[0]).toMatchObject({ status: 'offline' })
      expect(u.betriebe[0]!.boxen[0]!.gruende[0]).toMatchObject({ code: 'offline' })
      expect(u.zusammenfassung).toMatchObject({ offline: 1, ok: 0 })

      await anfrage('POST', '/api/box/meldung', meldung(), box.token)
      u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.boxen[0]!.status).toBe('ok')
    })

    it('Token erneuern: das alte gilt sofort nicht mehr, das neue funktioniert', async () => {
      const r = await admin('POST', `/api/boxen/${box.box.id}/token-erneuern`)
      expect(r.statusCode).toBe(200)
      const neu = r.json() as BoxMitToken
      expect(neu.token).not.toBe(box.token)

      expect((await anfrage('POST', '/api/box/meldung', meldung(), box.token)).statusCode).toBe(401)
      expect((await anfrage('POST', '/api/box/meldung', meldung(), neu.token)).statusCode).toBe(200)
      box = neu
      expect((await admin('POST', `/api/boxen/${G(77)}/token-erneuern`)).statusCode).toBe(404)
    })

    it('Box oder Betrieb deaktivieren: die Meldung wird abgelehnt; wieder aktivieren: sie geht wieder', async () => {
      await admin('PATCH', `/api/boxen/${box.box.id}`, { aktiv: false })
      expect((await anfrage('POST', '/api/box/meldung', meldung(), box.token)).statusCode).toBe(401)
      await admin('PATCH', `/api/boxen/${box.box.id}`, { aktiv: true })
      expect((await anfrage('POST', '/api/box/meldung', meldung(), box.token)).statusCode).toBe(200)

      await admin('PATCH', `/api/betriebe/${betriebId}`, { aktiv: false })
      expect((await anfrage('POST', '/api/box/meldung', meldung(), box.token)).statusCode).toBe(401)
      const u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.zusammenfassung.boxen).toBe(0) // deaktivierte Betriebe zählen nicht mit
      await admin('PATCH', `/api/betriebe/${betriebId}`, { aktiv: true })
      expect((await anfrage('POST', '/api/box/meldung', meldung(), box.token)).statusCode).toBe(200)
    })

    it('mehrere Boxen: der Betrieb zeigt den schlechtesten Status', async () => {
      const zweite = (await admin('POST', `/api/betriebe/${betriebId}/boxen`, { name: 'Zweitkassa' })).json() as BoxMitToken
      await anfrage('POST', '/api/box/meldung', meldung({ speicher: { zustand: 'kritisch', gesamtGb: 100, freiGb: 1, freiProzent: 1 } }), zweite.token)
      const u = (await admin('GET', '/api/uebersicht')).json() as Uebersicht
      expect(u.betriebe[0]!.boxen.map(b => [b.name, b.status])).toEqual([['Hauptkassa', 'ok'], ['Zweitkassa', 'kritisch']])
      expect(u.betriebe[0]!.status).toBe('kritisch')
      expect(u.zusammenfassung).toMatchObject({ boxen: 2, ok: 1, kritisch: 1 })
    })
  })

  // =========================================================================
  describe('Sonstiges', () => {
    it('Lebenszeichen ohne Anmeldung', async () => {
      const r = await anfrage('GET', '/api/health')
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ status: 'ok' })
    })

    it('kaputtes JSON → 400, zu großer Body → 413, unbekannte Route → 404', async () => {
      const kaputt = await server.inject({ method: 'POST', url: '/api/auth/anmelden', payload: '{nicht json', headers: { 'content-type': 'application/json' } })
      expect(kaputt.statusCode).toBe(400)
      const gross = await server.inject({ method: 'POST', url: '/api/auth/anmelden', payload: JSON.stringify({ x: 'a'.repeat(1_100_000) }), headers: { 'content-type': 'application/json' } })
      expect(gross.statusCode).toBe(413)
      expect((await anfrage('GET', '/api/gibt-es-nicht')).statusCode).toBe(404)
    })
  })
})
