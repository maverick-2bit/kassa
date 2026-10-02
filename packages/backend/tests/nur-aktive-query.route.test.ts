/**
 * Query-Parameter ?nurAktive der Stammdaten-Listen (GET /api/artikel, GET /api/kategorien).
 *
 * Regressions-Guard: z.coerce.boolean() machte aus dem Query-String "false" den
 * Wert true (Boolean("false") === true) — ?nurAktive=false lieferte dadurch nur
 * AKTIVE Einträge. Geprüft wird hier, was die Route tatsächlich an den Service
 * weiterreicht; das Verhalten gegen echtes PostgreSQL deckt
 * integration/nur-aktive-filter.test.ts ab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const listeArtikel    = vi.hoisted(() => vi.fn())
const listeKategorien = vi.hoisted(() => vi.fn())

vi.mock('../src/services/artikel.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/artikel.service.js')>()),
  listeArtikel,
}))
vi.mock('../src/services/kategorie.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/kategorie.service.js')>()),
  listeKategorien,
}))

const keineDb = {} as unknown as Db

const ROUTEN = [
  // Standard bleibt wie bisher: Artikel nur aktive, Warengruppen alle
  { url: '/api/artikel',    liste: listeArtikel,    standard: true  },
  { url: '/api/kategorien', liste: listeKategorien, standard: false },
]

describe.each(ROUTEN)('GET $url — ?nurAktive', ({ url, liste, standard }) => {
  beforeEach(() => {
    liste.mockReset()
    liste.mockResolvedValue([])
  })

  async function hole(query: string) {
    const srv = await buildTestServer(keineDb)
    try {
      return await srv.fastify.inject({ method: 'GET', url: `${url}${query}`, headers: srv.authHeader() })
    } finally {
      await srv.close()
    }
  }

  it('?nurAktive=true → nur aktive', async () => {
    const res = await hole('?nurAktive=true')
    expect(res.statusCode).toBe(200)
    expect(liste).toHaveBeenCalledWith(expect.anything(), expect.any(String), { nurAktive: true })
  })

  it('?nurAktive=false → auch deaktivierte (nicht mehr still true)', async () => {
    const res = await hole('?nurAktive=false')
    expect(res.statusCode).toBe(200)
    expect(liste).toHaveBeenCalledWith(expect.anything(), expect.any(String), { nurAktive: false })
  })

  it('ohne Parameter → bisheriger Standard', async () => {
    const res = await hole('')
    expect(res.statusCode).toBe(200)
    expect(liste).toHaveBeenCalledWith(expect.anything(), expect.any(String), { nurAktive: standard })
  })

  it('mandantId in der Query (schickt das Frontend mit) stört nicht und wird nicht übernommen', async () => {
    const res = await hole('?mandantId=00000000-0000-0000-0000-00000000dead&nurAktive=false')
    expect(res.statusCode).toBe(200)
    expect(liste).toHaveBeenCalledTimes(1)
    // Mandant kommt ausschließlich aus dem JWT
    expect(liste.mock.calls[0]![1]).not.toBe('00000000-0000-0000-0000-00000000dead')
    expect(liste.mock.calls[0]![2]).toEqual({ nurAktive: false })
  })

  it.each(['nein', 'ja', '1', '0', '', 'TRUE', 'False', 'undefined'])(
    '?nurAktive=%j → 400 statt stiller Umdeutung, Service bleibt unberührt',
    async (wert) => {
      const res = await hole(`?nurAktive=${wert}`)
      expect(res.statusCode).toBe(400)
      expect(res.json().fehler).toBeDefined()
      expect(liste).not.toHaveBeenCalled()
    },
  )

  it('mehrfach gesetzter Parameter → 400', async () => {
    const res = await hole('?nurAktive=true&nurAktive=false')
    expect(res.statusCode).toBe(400)
    expect(liste).not.toHaveBeenCalled()
  })
})
