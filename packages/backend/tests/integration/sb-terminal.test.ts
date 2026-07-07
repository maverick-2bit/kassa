/**
 * Integrationstest: SB-Terminal (Kiosk-Bestellung) gegen echtes PostgreSQL.
 *
 * Deckt den kompletten Lebenszyklus ab, den Mocks nicht beweisen können:
 *  - Modul-Gating (403 solange deaktiviert)
 *  - Sichtbarkeits-Vererbung Kategorie→Artikel (Override + serialisiert/ausgeschlossen)
 *  - Demo-Zahlung end-to-end: Bestellnummer täglich ab 1, RKSV-Beleg (Karte),
 *    KDS-Bons mit Kueche-Fallback + SB-Verknüpfung
 *  - ZVT-Stub-Flow über den öffentlichen Status-Poll (idempotente Finalisierung)
 *  - Statusübergänge: bereit via Kassa UND via letzter-KDS-Bon-erledigt, abgeholt
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { kassen } from '../../src/db/schema.js'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@sbterminal.at'
const ADMIN_PASSWORT = 'sbterminal-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'SBT-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'SB-Terminal Test GmbH',
  uid:        'ATU99999906',
  kassenId:   'SBT-001',
  finanzOnline: { teilnehmerId: 'TID-SBT', benutzerkennung: 'BID-SBT', pin: 'PIN-SBT' },
  umgebung: 'test',
  admin: { name: 'SBT Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

interface SbStatus {
  id: string; status: string; summeCent: number
  bestellNummer: number | null; demoZahlung: boolean
  zahlung: { status: string; meldung?: string } | null
}

describe('SB-Terminal (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let burgerId: string   // Kategorie sichtbar, erbt (station null → Kueche-Fallback)
  let colaId: string     // Kategorie sichtbar, Override false → versteckt
  let extraId: string    // ohne Kategorie, Override true → sichtbar
  let serialId: string   // serialisiert → ausgeschlossen

  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const loginRes = await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })
    const login = loginRes.json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Sortiment: sichtbare Kategorie + Artikel-Varianten
    const kat = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name: 'SB Speisen', farbe: 'rot', reihenfolge: 0, terminalSichtbar: true },
    })
    const katId = kat.json().id

    const mk = async (payload: Record<string, unknown>): Promise<string> => {
      const res = await srv.fastify.inject({ method: 'POST', url: '/api/artikel', headers: auth(), payload })
      if (res.statusCode !== 201) throw new Error(`Artikel (${res.statusCode}): ${res.body}`)
      return res.json().id
    }
    burgerId = await mk({ bezeichnung: 'SB Burger', preisBruttoCent: 890, mwstSatz: 'ermaessigt1', kategorieId: katId })
    colaId   = await mk({ bezeichnung: 'SB Cola', preisBruttoCent: 350, mwstSatz: 'normal', kategorieId: katId, terminalSichtbar: false })
    extraId  = await mk({ bezeichnung: 'SB Extra', preisBruttoCent: 450, mwstSatz: 'normal', terminalSichtbar: true })
    serialId = await mk({ bezeichnung: 'SB Gerät', preisBruttoCent: 9900, mwstSatz: 'normal', kategorieId: katId, seriennummernAktiv: true })
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  // ── Modul-Gating ─────────────────────────────────────────────────────────────
  it('liefert 403 solange das Modul deaktiviert ist (Default)', async () => {
    const sortiment = await srv.fastify.inject({ method: 'GET', url: `/api/terminal/sortiment?kasseId=${kasseId}` })
    expect(sortiment.statusCode).toBe(403)

    const bestellung = await srv.fastify.inject({
      method: 'POST', url: '/api/terminal/bestellung',
      payload: { kasseId, positionen: [{ artikelId: burgerId, menge: 1 }] },
    })
    expect(bestellung.statusCode).toBe(403)
  })

  it('Modul lässt sich über PATCH /mandanten/module aktivieren', async () => {
    const res = await srv.fastify.inject({
      method: 'PATCH', url: '/api/mandanten/module', headers: auth(),
      payload: { modulSbTerminalAktiv: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().modulSbTerminalAktiv).toBe(true)
  })

  // ── Sortiment (Sichtbarkeits-Vererbung) ──────────────────────────────────────
  it('Sortiment: Vererbung + Override + serialisiert ausgeschlossen', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/terminal/sortiment?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(200)
    const s = res.json() as { artikel: { id: string }[]; kategorien: { name: string }[] }
    const ids = s.artikel.map(a => a.id)

    expect(ids).toContain(burgerId)      // erbt von sichtbarer Kategorie
    expect(ids).toContain(extraId)       // Override true ohne Kategorie
    expect(ids).not.toContain(colaId)    // Override false schlägt Kategorie
    expect(ids).not.toContain(serialId)  // serialisiert → kein Kiosk-Verkauf
    expect(s.kategorien.map(k => k.name)).toContain('SB Speisen')
  })

  it('nicht sichtbare/serialisierte Artikel sind nicht bestellbar (400)', async () => {
    for (const artikelId of [colaId, serialId]) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/terminal/bestellung',
        payload: { kasseId, positionen: [{ artikelId, menge: 1 }] },
      })
      expect(res.statusCode).toBe(400)
    }
  })

  // ── Demo-Zahlung end-to-end ──────────────────────────────────────────────────
  let ersteBestellungId: string

  it('Demo-Bestellung: bestätigen vergibt Nummer 1, signiert Beleg und boniert ans KDS', async () => {
    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/terminal/bestellung',
      payload: { kasseId, positionen: [{ artikelId: burgerId, menge: 2 }, { artikelId: extraId, menge: 1 }] },
    })
    expect(anlage.statusCode).toBe(201)
    const angelegt = anlage.json() as SbStatus
    expect(angelegt.status).toBe('zahlung')
    expect(angelegt.demoZahlung).toBe(true)
    expect(angelegt.summeCent).toBe(2 * 890 + 450)
    ersteBestellungId = angelegt.id

    const bestaetigt = await srv.fastify.inject({
      method: 'POST', url: `/api/terminal/bestellung/${angelegt.id}/bestaetigen`,
    })
    expect(bestaetigt.statusCode).toBe(200)
    const fertig = bestaetigt.json() as SbStatus
    expect(fertig.status).toBe('offen')
    expect(fertig.bestellNummer).toBe(1)

    // RKSV-Beleg: Kartenzahlung in voller Höhe, signiert
    const belege = await srv.fastify.inject({ method: 'GET', url: `/api/belege?kasseId=${kasseId}`, headers: auth() })
    const beleg = (belege.json() as { belegTyp: string; summeKarteCent: number; signaturwert: string }[])
      .find(b => b.belegTyp === 'Barzahlungsbeleg' && b.summeKarteCent === 2 * 890 + 450)
    expect(beleg).toBeDefined()
    expect(beleg!.signaturwert).toBeTruthy()

    // KDS: Bon auf Station kueche (Fallback — Artikel haben keine Station), SB-verknüpft
    const bons = await srv.fastify.inject({ method: 'GET', url: '/api/kds/bons?station=kueche', headers: auth() })
    expect(bons.statusCode).toBe(200)
    const sbBons = (bons.json() as { tisch: string; sbBestellNummer?: string }[])
      .filter(b => b.sbBestellNummer === '0001')
    expect(sbBons.length).toBe(1)
    expect(sbBons[0]!.tisch).toBe('SB 0001')
  })

  it('zweite Bestellung am selben Tag erhält Nummer 2', async () => {
    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/terminal/bestellung',
      payload: { kasseId, positionen: [{ artikelId: extraId, menge: 1 }] },
    })
    const id = (anlage.json() as SbStatus).id
    const res = await srv.fastify.inject({ method: 'POST', url: `/api/terminal/bestellung/${id}/bestaetigen` })
    expect((res.json() as SbStatus).bestellNummer).toBe(2)
  })

  // ── Statusübergänge ──────────────────────────────────────────────────────────
  it('zentrale Kassa quittiert „bereit", KDS quittiert „abgeholt"', async () => {
    const bereit = await srv.fastify.inject({
      method: 'POST', url: `/api/sb-bestellungen/${ersteBestellungId}/bereit`, headers: auth(),
    })
    expect(bereit.statusCode).toBe(200)
    expect(bereit.json().status).toBe('bereit')

    const abgeholt = await srv.fastify.inject({
      method: 'POST', url: `/api/sb-bestellungen/${ersteBestellungId}/abgeholt`, headers: auth(),
    })
    expect(abgeholt.statusCode).toBe(200)
    expect(abgeholt.json().status).toBe('abgeholt')

    // bereit auf abgeholter Bestellung → 404 (kein gültiger Übergang)
    const nochmal = await srv.fastify.inject({
      method: 'POST', url: `/api/sb-bestellungen/${ersteBestellungId}/bereit`, headers: auth(),
    })
    expect(nochmal.statusCode).toBe(404)
  })

  it('letzter erledigter KDS-Bon setzt die Bestellung automatisch auf „bereit"', async () => {
    // Nummer 2 ist noch offen — ihren KDS-Bon erledigen
    const bons = await srv.fastify.inject({ method: 'GET', url: '/api/kds/bons?station=kueche', headers: auth() })
    const bon = (bons.json() as { id: string; sbBestellNummer?: string }[]).find(b => b.sbBestellNummer === '0002')
    expect(bon).toBeDefined()

    const erledigt = await srv.fastify.inject({
      method: 'POST', url: `/api/kds/bon/${bon!.id}/erledigt`, headers: auth(),
    })
    expect(erledigt.statusCode).toBe(200)

    const liste = await srv.fastify.inject({ method: 'GET', url: '/api/sb-bestellungen', headers: auth() })
    const eintrag = (liste.json() as { bestellNummer: number; status: string }[]).find(b => b.bestellNummer === 2)
    expect(eintrag?.status).toBe('bereit')
  })

  // ── ZVT-Stub-Flow ────────────────────────────────────────────────────────────
  it('ZVT-Stub: Status-Poll finalisiert nach Zahlungserfolg (Nummer 3)', async () => {
    await idb.db.update(kassen).set({ zvtAktiv: true, zvtIp: 'stub' }).where(eq(kassen.id, kasseId))

    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/terminal/bestellung',
      payload: { kasseId, positionen: [{ artikelId: burgerId, menge: 1 }] },
    })
    expect(anlage.statusCode).toBe(201)
    const angelegt = anlage.json() as SbStatus
    expect(angelegt.demoZahlung).toBe(false)

    // Demo-Bestätigung ist im ZVT-Modus gesperrt
    const demo = await srv.fastify.inject({ method: 'POST', url: `/api/terminal/bestellung/${angelegt.id}/bestaetigen` })
    expect(demo.statusCode).toBe(409)

    // Poll bis der Stub die Zahlung abschließt (~3,5 s) und der Poll finalisiert
    let status: SbStatus | null = null
    for (let i = 0; i < 40; i++) {
      const res = await srv.fastify.inject({ method: 'GET', url: `/api/terminal/bestellung/${angelegt.id}` })
      status = res.json() as SbStatus
      if (status.status !== 'zahlung') break
      await new Promise(r => setTimeout(r, 300))
    }
    expect(status?.status).toBe('offen')
    expect(status?.bestellNummer).toBe(3)

    await idb.db.update(kassen).set({ zvtAktiv: false, zvtIp: null }).where(eq(kassen.id, kasseId))
  }, 20_000)

  it('Abbruch im Demo-Modus setzt die Bestellung auf „abgebrochen"', async () => {
    const anlage = await srv.fastify.inject({
      method: 'POST', url: '/api/terminal/bestellung',
      payload: { kasseId, positionen: [{ artikelId: extraId, menge: 1 }] },
    })
    const id = (anlage.json() as SbStatus).id
    const abbruch = await srv.fastify.inject({ method: 'POST', url: `/api/terminal/bestellung/${id}/abbrechen` })
    expect(abbruch.statusCode).toBe(200)
    expect((abbruch.json() as SbStatus).status).toBe('abgebrochen')
  })
})
