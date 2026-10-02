/**
 * Integrationstest: gleichnamige Warengruppen („Alkoholfrei" unter drei verschiedenen Elterngruppen)
 * in den serverseitig gelieferten Listen — Gast-Karte und SB-Terminal-Sortiment kommen in BAUM-
 * Reihenfolge mit Pfad-Namen bei Namensgleichheit, die Kassen-Sichtbarkeit gilt samt Untergruppen
 * (wie an der Kasse) — und der Optionen-Import ordnet über den Pfad „Atriumbar/Alkoholfrei" zu.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const mockFoClient = (): FinanzOnlineClient => ({
  kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
  startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'KB-PW' }),
  kasseAusserBetriebNehmen: vi.fn(),
} as unknown as FinanzOnlineClient)

describe('Warengruppen-Baum in Gast-Karte, Terminal-Sortiment und Optionen-Import (Integration)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = '', kasseId = ''
  const auth = () => ({ authorization: `Bearer ${token}` })
  const ids: Record<string, string> = {}
  let sodaAtr = '', sodaKel = ''

  const gruppe = async (schluessel: string, name: string, parent: string | null, reihenfolge: number) => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name, farbe: 'grau', reihenfolge, parentId: parent ? ids[parent] : null, terminalSichtbar: true },
    })
    expect(res.statusCode, res.body).toBe(201)
    ids[schluessel] = res.json().id
  }
  const artikel = async (bezeichnung: string, kategorie: string) => {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/artikel', headers: auth(),
      payload: { bezeichnung, preisBruttoCent: 300, mwstSatz: 'normal', kategorieId: ids[kategorie] },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().id as string
  }
  const setzeSichtbarkeit = async (liste: string[]) =>
    expect((await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(), payload: { sichtbareKategorieIds: liste },
    })).statusCode).toBe(204)

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const s = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Baum GmbH', uid: 'ATU99999977', kassenId: 'KB-001',
        finanzOnline: { teilnehmerId: 'TID-KB', benutzerkennung: 'BID-KB', pin: 'PIN-KB' }, umgebung: 'test',
        admin: { name: 'KB Admin', email: 'admin@baum-anzeige.at', passwort: 'baum-anzeige-passwort-123' },
      },
    })
    if (s.statusCode !== 201) throw new Error(`Setup (${s.statusCode}): ${s.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'admin@baum-anzeige.at', passwort: 'baum-anzeige-passwort-123' },
    })).json()
    token = login.token; kasseId = login.kassen[0].id

    // Bewusst NICHT in Baumreihenfolge angelegt; reihenfolge = Position unter Geschwistern
    await gruppe('grillen', 'Grillen', null, 3)
    await gruppe('kel', 'Kellner Getränke', null, 1)
    await gruppe('atr', 'Atriumbar', null, 0)
    await gruppe('evt', 'Eventmanagement', null, 2)
    await gruppe('kelAlk', 'Alkoholfrei', 'kel', 0)
    await gruppe('atrAlk', 'Alkoholfrei', 'atr', 0)
    await gruppe('atrBier', 'Bier', 'atr', 1)
    await gruppe('kelBier', 'Bier', 'kel', 1)
    await gruppe('atrLim', 'Limonaden', 'atrAlk', 0)
    await gruppe('evtPak', 'Event Getränke & Pakete', 'evt', 0)
    await gruppe('evtAlk', 'Alkoholfrei', 'evtPak', 0)
    sodaAtr = await artikel('Soda', 'atrAlk')
    sodaKel = await artikel('Soda', 'kelAlk')
    await artikel('Limo', 'atrLim')
    await artikel('Wasser', 'evtAlk')

    const modul = await srv.fastify.inject({ method: 'PATCH', url: '/api/mandanten/module', headers: auth(), payload: { modulSbTerminalAktiv: true } })
    expect(modul.statusCode, modul.body).toBe(200)
    const gm = await srv.fastify.inject({ method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(), payload: { gastModus: 'tab' } })
    expect(gm.statusCode, gm.body).toBe(200)
  })
  afterAll(async () => { await srv?.close(); await idb?.zerstoeren() })

  const BAUM_NAMEN = [
    'Atriumbar',
    'Atriumbar › Alkoholfrei',      // gleichnamig → Pfad
    'Limonaden',                    // eindeutig → nur der Name
    'Atriumbar › Bier',             // gleichnamig → Pfad
    'Kellner Getränke',
    'Kellner Getränke › Alkoholfrei',
    'Kellner Getränke › Bier',
    'Eventmanagement',
    'Event Getränke & Pakete',
    'Eventmanagement › Event Getränke & Pakete › Alkoholfrei',
    'Grillen',
  ]

  it('SB-Terminal-Sortiment: Reiter in Baumreihenfolge, gleichnamige Gruppen mit Pfad', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/terminal/sortiment?kasseId=${kasseId}` })
    expect(res.statusCode, res.body).toBe(200)
    const s = res.json() as { kategorien: { id: string; name: string }[] }
    expect(s.kategorien.map(k => k.name)).toEqual(BAUM_NAMEN)
    // die drei „Alkoholfrei" sind drei verschiedene Reiter mit verschiedenen Namen
    const alk = s.kategorien.filter(k => k.id === ids.atrAlk || k.id === ids.kelAlk || k.id === ids.evtAlk)
    expect(new Set(alk.map(k => k.name)).size).toBe(3)
  })

  it('Gast-Karte ohne Einschränkung: Baumreihenfolge + Pfad-Namen', async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })
    expect(res.statusCode, res.body).toBe(200)
    const k = res.json() as { kategorien: { id: string; name: string; reihenfolge: number }[] }
    expect(k.kategorien.map(x => x.name)).toEqual(BAUM_NAMEN)
    // `reihenfolge` bleibt die Position unter Geschwistern (wird nicht überschrieben)
    expect(k.kategorien.find(x => x.id === ids.kelBier)!.reihenfolge).toBe(1)
  })

  it('Gast-Karte mit Kassen-Auswahl: Untergruppen und Zugang (Elterngruppe) wie an der Kasse', async () => {
    // Auswahl: nur „Kellner › Alkoholfrei" → die Elterngruppe bleibt als Zugang, andere Teilbäume fehlen
    await setzeSichtbarkeit([ids.kelAlk!])
    let k = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })).json() as { kategorien: { name: string }[] }
    expect(k.kategorien.map(x => x.name)).toEqual(['Kellner Getränke', 'Kellner Getränke › Alkoholfrei'])
    // Auswahl: Elterngruppe „Atriumbar" → samt allen Untergruppen
    await setzeSichtbarkeit([ids.atr!])
    k = (await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })).json() as { kategorien: { name: string }[] }
    expect(k.kategorien.map(x => x.name)).toEqual(['Atriumbar', 'Atriumbar › Alkoholfrei', 'Limonaden', 'Atriumbar › Bier'])
    await setzeSichtbarkeit([])
  })

  it('Optionen-Import: gleichnamige Warengruppen trennt der Pfad; ein reiner Name bleibt mehrdeutig', async () => {
    const eintrag = (warengruppe: string) => ({
      artikel: 'Soda', warengruppe, gruppe: 'Variante', typ: 'optional', maxAuswahl: 1,
      optionen: [{ name: 'Still', aufschlagCent: 0 }, { name: 'Prickelnd', aufschlagCent: 0 }],
    })
    const importiere = async (e: ReturnType<typeof eintrag>[]) => (await srv.fastify.inject({
      method: 'POST', url: '/api/modifikator-gruppen/import', headers: auth(), payload: { eintraege: e },
    })).json() as { gruppenNeu: number; zuweisungenNeu: number; fehler: { artikel: string; fehler: string }[] }

    // reiner Name „Alkoholfrei": zwei Artikel „Soda" in gleichnamigen Gruppen → nicht entscheidbar
    const mehrdeutig = await importiere([eintrag('Alkoholfrei')])
    expect(mehrdeutig.zuweisungenNeu).toBe(0)
    expect(mehrdeutig.fehler[0]!.fehler).toMatch(/Pfad/)

    // Pfad (mit „/" oder „›", Groß/klein egal) → genau der Soda aus Atriumbar bzw. Kellner Getränke
    const ergebnis = await importiere([eintrag('atriumbar/Alkoholfrei'), eintrag('Kellner Getränke › Alkoholfrei')])
    expect(ergebnis.fehler).toEqual([])
    expect(ergebnis.zuweisungenNeu).toBe(2)
    expect(ergebnis.gruppenNeu).toBe(1)               // inhaltsgleiche Gruppe nur einmal angelegt
    const zuw = (await srv.fastify.inject({ method: 'GET', url: '/api/artikel-modifikator-gruppen', headers: auth() })).json() as { artikelId: string }[]
    expect(zuw.map(z => z.artikelId).sort()).toEqual([sodaAtr, sodaKel].sort())
  })
})
