/**
 * Integrationstest: Gast-Karte und Warengruppen-Sichtbarkeit je Kasse gegen echtes PostgreSQL.
 *
 * Jede Warengruppe wird UNABHÄNGIG gewählt: ein Haken gilt nur für diese Gruppe, nicht für ihre
 * Untergruppen (wer „Alkoholfrei" wählt, hat damit nicht automatisch „Limonaden" und „Säfte"). Die
 * Gast-Karte zeigt die Gruppen flach als Reiter — also genau die ausdrücklich gewählten, in Baumreihenfolge;
 * ein Zugang über die Elterngruppe entfällt. Leere Liste = alle Gruppen.
 *
 * Vorher galt die gespeicherte Auswahl samt allen Untergruppen und deren Vorfahren
 * (shared: erweitereSichtbarkeit) — „nur Alkoholfrei" war nicht darstellbar.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FinanzOnlineClient } from '@kassa/rksv'
import { buildTestServer, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from './helpers/integrationsDb.js'

const ADMIN_EMAIL    = 'admin@gast-sichtbarkeit.at'
const ADMIN_PASSWORT = 'gast-sichtbarkeit-passwort-123'

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:     vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:        vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'ITEST-PW' }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

const setupInput = {
  firmenname: 'Gast Sichtbarkeit GmbH',
  uid:        'ATU99999951',
  kassenId:   'GSICHT-001',
  finanzOnline: { teilnehmerId: 'TID-GS', benutzerkennung: 'BID-GS', pin: 'PIN-GS' },
  umgebung: 'test',
  admin: { name: 'GS Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
}

describe('Gast-Karte: jede Warengruppe einzeln gewählt (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token = ''
  let kasseId = ''
  /** Namen → IDs der angelegten Gruppen */
  const g: Record<string, string> = {}

  const auth = () => ({ authorization: `Bearer ${token}` })

  async function gruppe(name: string, parentId: string | null, reihenfolge: number): Promise<string> {
    const res = await srv.fastify.inject({
      method: 'POST', url: '/api/kategorien', headers: auth(),
      payload: { name, farbe: 'blau', reihenfolge, parentId },
    })
    if (res.statusCode !== 201) throw new Error(`Gruppe „${name}" (${res.statusCode}): ${res.body}`)
    g[name] = res.json().id
    return g[name]!
  }

  async function setzeAuswahl(namen: string[]) {
    const res = await srv.fastify.inject({
      method: 'PUT', url: `/api/kassen/${kasseId}/pos-config`, headers: auth(),
      payload: { sichtbareKategorieIds: namen.map(n => g[n]) },
    })
    if (res.statusCode !== 204) throw new Error(`pos-config (${res.statusCode}): ${res.body}`)
  }

  const karte = async () => {
    const res = await srv.fastify.inject({ method: 'GET', url: `/api/gast/karte?kasseId=${kasseId}` })
    expect(res.statusCode).toBe(200)
    return res.json() as { kategorien: { id: string; name: string }[]; artikel: { id: string; kategorieId: string | null }[] }
  }
  const reiter = async () => (await karte()).kategorien.map(k => k.name)

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })

    const setupRes = await srv.fastify.inject({ method: 'POST', url: '/api/setup', payload: setupInput })
    if (setupRes.statusCode !== 201) throw new Error(`Setup (${setupRes.statusCode}): ${setupRes.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    // Die Karte gibt es nur, wenn die Gast-Bestellung an dieser Kasse eingeschaltet ist
    const modus = await srv.fastify.inject({
      method: 'PATCH', url: `/api/kassen/${kasseId}/drucker`, headers: auth(), payload: { gastModus: 'tab' },
    })
    if (modus.statusCode !== 200) throw new Error(`Gast-Modus (${modus.statusCode}): ${modus.body}`)

    //   Atriumbar
    //     Alkoholfrei
    //       Limonaden
    //       Säfte
    //     Bier
    //   Kellner
    //   Grillen
    const atr = await gruppe('Atriumbar', null, 0)
    const alko = await gruppe('Alkoholfrei', atr, 0)
    await gruppe('Limonaden', alko, 0)
    await gruppe('Säfte', alko, 1)
    await gruppe('Bier', atr, 1)
    await gruppe('Kellner', null, 1)
    await gruppe('Grillen', null, 2)

    // je Gruppe ein Artikel — alle bleiben in der Karte (die Reiter bestimmen, was der Gast sieht)
    for (const name of Object.keys(g)) {
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/artikel', headers: auth(),
        payload: { bezeichnung: `Artikel ${name}`, preisBruttoCent: 300, mwstSatz: 'normal', kategorieId: g[name] },
      })
      if (res.statusCode !== 201) throw new Error(`Artikel (${res.statusCode}): ${res.body}`)
    }
  })

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it('ohne Einschränkung (leere Liste) zeigt die Karte alle Gruppen in Baumreihenfolge', async () => {
    await setzeAuswahl([])
    expect(await reiter()).toEqual(['Atriumbar', 'Alkoholfrei', 'Limonaden', 'Säfte', 'Bier', 'Kellner', 'Grillen'])
  })

  it('NUR „Alkoholfrei" gewählt: genau diese Gruppe — keine Limonaden/Säfte, keine Atriumbar', async () => {
    await setzeAuswahl(['Alkoholfrei'])
    expect(await reiter()).toEqual(['Alkoholfrei'])
  })

  it('danach „Limonaden" zusätzlich gewählt: beide, in Baumreihenfolge (Säfte bleibt weg)', async () => {
    await setzeAuswahl(['Limonaden', 'Alkoholfrei'])
    expect(await reiter()).toEqual(['Alkoholfrei', 'Limonaden'])
  })

  it('nur die Elterngruppe gewählt: ohne ihre Untergruppen', async () => {
    await setzeAuswahl(['Atriumbar'])
    expect(await reiter()).toEqual(['Atriumbar'])
  })

  it('Elterngruppe + eine Untergruppe', async () => {
    await setzeAuswahl(['Atriumbar', 'Bier'])
    expect(await reiter()).toEqual(['Atriumbar', 'Bier'])
  })

  it('ältere gespeicherte Liste mit vollem Teilbaum (Gruppe + alle Untergruppen) zeigt wie bisher den ganzen Teilbaum', async () => {
    await setzeAuswahl(['Atriumbar', 'Alkoholfrei', 'Limonaden', 'Säfte', 'Bier'])
    expect(await reiter()).toEqual(['Atriumbar', 'Alkoholfrei', 'Limonaden', 'Säfte', 'Bier'])
  })

  it('die Artikel bleiben in der Karte; der Gast sieht je Reiter nur die Artikel dieser Gruppe', async () => {
    await setzeAuswahl(['Alkoholfrei'])
    const k = await karte()
    const alkoId = g['Alkoholfrei']!
    expect(k.kategorien.map(x => x.id)).toEqual([alkoId])
    expect(k.artikel.filter(a => a.kategorieId === alkoId)).toHaveLength(1)
    // Reihenfolge der Auswahl ist ohne Bedeutung — und leer stellt alles wieder her
    await setzeAuswahl([])
    expect((await karte()).kategorien).toHaveLength(7)
  })
})
