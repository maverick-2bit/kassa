/**
 * uuidParam/uuidQuery — uuid-Pfad- und Query-Parameter prüfen, bevor sie eine
 * Abfrage erreichen. Das Zusammenspiel mit den echten Routen prüfen
 * tests/integration/ungueltige-id.test.ts und ungueltige-query-id.test.ts.
 */

import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'
import { fehlerHandler } from '../src/fehler-handler.js'
import { uuidParam, uuidQuery, UngueltigeIdError } from '../src/routes/uuid-param.js'

const ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

describe('uuidParam', () => {
  it('liefert eine gültige uuid unverändert zurück', () => {
    expect(uuidParam({ id: ID })).toBe(ID)
    expect(uuidParam({ id: ID.toUpperCase() })).toBe(ID.toUpperCase())
    expect(uuidParam({ kasseId: ID }, 'kasseId')).toBe(ID)
  })

  it.each([
    ['kein uuid',                'kein-uuid'],
    ['leer',                     ''],
    ['angehängte Zeichen',       `${ID}x`],
    ['führendes Leerzeichen',    ` ${ID}`],
    ['Nicht-Hex-Zeichen',        'ta000000-0000-0000-0000-000000000001'],
    ['ohne Bindestriche',        ID.replace(/-/g, '')],
  ])('%s → UngueltigeIdError', (_fall, wert) => {
    expect(() => uuidParam({ id: wert })).toThrow(UngueltigeIdError)
  })

  it('fehlender Parameter → UngueltigeIdError', () => {
    expect(() => uuidParam({})).toThrow(UngueltigeIdError)
    expect(() => uuidParam({ id: ID }, 'kasseId')).toThrow(UngueltigeIdError)
    expect(() => uuidParam(undefined)).toThrow(UngueltigeIdError)
  })

  it('UngueltigeIdError ist ein Fachfehler: httpStatus 400, Meldung „Ungültige ID"', () => {
    const fehler = new UngueltigeIdError()
    expect(fehler).toBeInstanceOf(Error)
    expect(fehler.httpStatus).toBe(400)
    expect(fehler.message).toBe('Ungültige ID')
  })

  it('der globale Fehler-Handler antwortet 400 { fehler: "Ungültige ID" }', async () => {
    const app = Fastify()
    app.setErrorHandler(fehlerHandler)
    app.get('/dinge/:id', async request => ({ id: uuidParam(request.params) }))
    try {
      const falsch = await app.inject({ method: 'GET', url: '/dinge/kein-uuid' })
      expect(falsch.statusCode).toBe(400)
      expect(falsch.json()).toEqual({ fehler: 'Ungültige ID' })

      const richtig = await app.inject({ method: 'GET', url: `/dinge/${ID}` })
      expect(richtig.statusCode).toBe(200)
      expect(richtig.json()).toEqual({ id: ID })
    } finally {
      await app.close()
    }
  })
})

describe('uuidQuery', () => {
  it('liefert eine gültige uuid unverändert zurück', () => {
    expect(uuidQuery({ kundeId: ID }, 'kundeId')).toBe(ID)
    expect(uuidQuery({ kundeId: ID.toUpperCase() }, 'kundeId')).toBe(ID.toUpperCase())
  })

  it('fehlender oder leerer Parameter → undefined (kein Filter, wie bisher)', () => {
    expect(uuidQuery({}, 'kundeId')).toBeUndefined()
    expect(uuidQuery({ kundeId: '' }, 'kundeId')).toBeUndefined()
    expect(uuidQuery({ kasseId: ID }, 'kundeId')).toBeUndefined()
    expect(uuidQuery(undefined, 'kundeId')).toBeUndefined()
  })

  it.each([
    ['kein uuid',                   'kein-uuid'],
    ['nur Leerzeichen',             ' '],
    ['angehängte Zeichen',          `${ID}x`],
    ['Nicht-Hex-Zeichen',           'ta000000-0000-0000-0000-000000000001'],
    ['mehrfach übergeben (Array)',  [ID, ID]],
  ])('%s → UngueltigeIdError', (_fall, wert) => {
    expect(() => uuidQuery({ kundeId: wert }, 'kundeId')).toThrow(UngueltigeIdError)
  })

  it('der globale Fehler-Handler antwortet 400 { fehler: "Ungültige ID" }', async () => {
    const app = Fastify()
    app.setErrorHandler(fehlerHandler)
    app.get('/dinge', async request => ({ kundeId: uuidQuery(request.query, 'kundeId') ?? null }))
    try {
      const falsch = await app.inject({ method: 'GET', url: '/dinge?kundeId=kein-uuid' })
      expect(falsch.statusCode).toBe(400)
      expect(falsch.json()).toEqual({ fehler: 'Ungültige ID' })

      const doppelt = await app.inject({ method: 'GET', url: `/dinge?kundeId=${ID}&kundeId=${ID}` })
      expect(doppelt.statusCode).toBe(400)
      expect(doppelt.json()).toEqual({ fehler: 'Ungültige ID' })

      const ohne = await app.inject({ method: 'GET', url: '/dinge?kundeId=' })
      expect(ohne.statusCode).toBe(200)
      expect(ohne.json()).toEqual({ kundeId: null })

      const richtig = await app.inject({ method: 'GET', url: `/dinge?kundeId=${ID}` })
      expect(richtig.statusCode).toBe(200)
      expect(richtig.json()).toEqual({ kundeId: ID })
    } finally {
      await app.close()
    }
  })
})
