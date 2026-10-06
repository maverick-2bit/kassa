/**
 * GET /api/system/fernwartung — Fernwartungs-Anbindung dieser Kasse (nur Admin).
 *
 * Die Route liest ausschließlich die Statusdatei `fernwartung-status.json`, die der
 * Installer ins Kontroll-Volume (UPDATE_CONTROL_DIR) legt. Geprüft wird die Fremdeingabe:
 * keine Datei, kaputtes JSON, falscher Anbieter, ungültige ID, Zusatzfelder — nie ein 500,
 * nie ein durchgereichtes Fremdfeld — sowie die Zugriffsregeln (401 ohne Token, 403 ohne
 * Admin-Rolle).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

const keineDb = {} as unknown as Db

const NICHT_EINGERICHTET = {
  eingerichtet: false, anbieter: null, id: null, alias: null, gruppe: null, installiertAm: null,
}

const GUELTIG = {
  anbieter: 'teamviewer', id: '123456789', alias: 'Kassa Gasthof Mayr', gruppe: 'Mietkassen',
  installiertAm: '2026-10-06T20:15:00Z',
}

let verzeichnis: string
const vorherControl = process.env.UPDATE_CONTROL_DIR
const vorherStatus  = process.env.FERNWARTUNG_STATUS_DIR

beforeEach(async () => {
  verzeichnis = await mkdtemp(join(tmpdir(), 'kassa-fernwartung-'))
  process.env.UPDATE_CONTROL_DIR = verzeichnis
  delete process.env.FERNWARTUNG_STATUS_DIR
})

afterEach(async () => {
  if (vorherControl === undefined) delete process.env.UPDATE_CONTROL_DIR; else process.env.UPDATE_CONTROL_DIR = vorherControl
  if (vorherStatus === undefined) delete process.env.FERNWARTUNG_STATUS_DIR; else process.env.FERNWARTUNG_STATUS_DIR = vorherStatus
  await rm(verzeichnis, { recursive: true, force: true })
})

async function hole(opts: { rolle?: 'admin' | 'kellner'; ohneToken?: boolean } = {}) {
  const srv = await buildTestServer(keineDb)
  try {
    return await srv.fastify.inject({
      method:  'GET',
      url:     '/api/system/fernwartung',
      headers: opts.ohneToken ? {} : srv.authHeader({ rolle: opts.rolle ?? 'admin' }),
    })
  } finally {
    await srv.close()
  }
}

const schreibe = (inhalt: unknown) =>
  writeFile(join(verzeichnis, 'fernwartung-status.json'), typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt), 'utf8')

describe('Zugriff', () => {
  it('ohne Token → 401', async () => {
    const res = await hole({ ohneToken: true })
    expect(res.statusCode).toBe(401)
  })

  it('Kellner → 403', async () => {
    await schreibe(GUELTIG)
    const res = await hole({ rolle: 'kellner' })
    expect(res.statusCode).toBe(403)
    // auch im Fehlerfall keine Daten
    expect(res.body).not.toContain('123456789')
  })

  it('Geräte-Token (KDS) → 403', async () => {
    await schreibe(GUELTIG)
    const srv = await buildTestServer(keineDb)
    try {
      const token = srv.fastify.jwt.sign({
        sub: '20000000-0000-0000-0000-000000000001', mandantId: '10000000-0000-0000-0000-000000000001',
        rolle: 'admin', name: 'KDS', berechtigungen: [], typ: 'kds_geraet',
      })
      const res = await srv.fastify.inject({
        method: 'GET', url: '/api/system/fernwartung', headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await srv.close()
    }
  })

  it('Admin → 200', async () => {
    const res = await hole()
    expect(res.statusCode).toBe(200)
  })
})

describe('Statusdatei', () => {
  it('keine Datei → nicht eingerichtet (kein Fehler)', async () => {
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('Verzeichnis existiert nicht → nicht eingerichtet', async () => {
    process.env.UPDATE_CONTROL_DIR = join(verzeichnis, 'gibt-es-nicht')
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('gültige Datei → eingerichtet mit allen Feldern', async () => {
    await schreibe(GUELTIG)
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      eingerichtet: true, anbieter: 'teamviewer', id: '123456789',
      alias: 'Kassa Gasthof Mayr', gruppe: 'Mietkassen', installiertAm: '2026-10-06T20:15:00.000Z',
    })
  })

  it('Datei vom Windows-Installer: ASCII mit \\u-Escapes (Umlaute) wird korrekt gelesen', async () => {
    await schreibe('{"anbieter":"teamviewer","id":"1234567890","alias":"Caf\\u00e9 M\\u00fcller","gruppe":null,"installiertAm":"2026-10-06T20:15:00Z"}')
    const res = await hole()
    expect(res.json()).toMatchObject({ eingerichtet: true, id: '1234567890', alias: 'Café Müller', gruppe: null })
  })

  it('nur Pflichtfelder (anbieter, id) genügen', async () => {
    await schreibe({ anbieter: 'teamviewer', id: '987654321' })
    const res = await hole()
    expect(res.json()).toEqual({ ...NICHT_EINGERICHTET, eingerichtet: true, anbieter: 'teamviewer', id: '987654321' })
  })

  it('Datei mit BOM wird gelesen', async () => {
    await schreibe('﻿' + JSON.stringify(GUELTIG))
    const res = await hole()
    expect(res.json().eingerichtet).toBe(true)
  })

  it('ID als Zahl (von Hand geschrieben) ist erlaubt', async () => {
    await schreibe({ ...GUELTIG, id: 123456789 })
    const res = await hole()
    expect(res.json()).toMatchObject({ eingerichtet: true, id: '123456789' })
  })

  it('kaputtes JSON → nicht eingerichtet, kein 500', async () => {
    await schreibe('{ "anbieter": "teamviewer", "id": ')
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('leere Datei → nicht eingerichtet', async () => {
    await schreibe('')
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('JSON-Array statt Objekt → nicht eingerichtet', async () => {
    await schreibe('[1,2,3]')
    expect((await hole()).json()).toEqual(NICHT_EINGERICHTET)
  })

  it.each([
    ['Buchstaben in der ID', { ...GUELTIG, id: '12345abcd' }],
    ['ID mit Leerzeichen', { ...GUELTIG, id: '123 456 789' }],
    ['ID zu kurz', { ...GUELTIG, id: '12345' }],
    ['ID zu lang', { ...GUELTIG, id: '1234567890123' }],
    ['ID leer', { ...GUELTIG, id: '' }],
    ['ID fehlt', { anbieter: 'teamviewer', alias: 'x' }],
    ['ID kein Text/Zahl', { ...GUELTIG, id: { x: 1 } }],
    ['negative ID', { ...GUELTIG, id: -123456789 }],
    ['Einschleusversuch in der ID', { ...GUELTIG, id: '123456789; rm -rf /' }],
    ['unbekannter Anbieter', { ...GUELTIG, anbieter: 'anydesk' }],
    ['Anbieter fehlt', { id: '123456789' }],
    ['Alias kein Text', { ...GUELTIG, alias: 42 }],
    ['Alias zu lang', { ...GUELTIG, alias: 'x'.repeat(201) }],
    ['Zeitpunkt ungültig', { ...GUELTIG, installiertAm: 'gestern' }],
  ])('ungültig (%s) → nicht eingerichtet', async (_name, inhalt) => {
    await schreibe(inhalt)
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('Zusatzfelder (z. B. versehentlich ein Token) werden NIE weitergereicht', async () => {
    await schreibe({ ...GUELTIG, apiToken: 'geheim-1234567', assignmentId: 'sehr-geheim', passwort: 'x' })
    const res = await hole()
    expect(res.json().eingerichtet).toBe(true)
    expect(Object.keys(res.json()).sort()).toEqual(['alias', 'anbieter', 'eingerichtet', 'gruppe', 'id', 'installiertAm'])
    expect(res.body).not.toContain('geheim')
    expect(res.body).not.toContain('passwort')
  })

  it('übergroße Datei → nicht eingerichtet (wird nicht eingelesen)', async () => {
    await schreibe(JSON.stringify({ ...GUELTIG, alias: 'x'.repeat(40_000) }))
    expect((await hole()).json()).toEqual(NICHT_EINGERICHTET)
  })

  it('Verzeichnis statt Datei → nicht eingerichtet', async () => {
    await mkdir(join(verzeichnis, 'fernwartung-status.json'))
    const res = await hole()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(NICHT_EINGERICHTET)
  })

  it('FERNWARTUNG_STATUS_DIR hat Vorrang vor UPDATE_CONTROL_DIR', async () => {
    const anderes = await mkdtemp(join(tmpdir(), 'kassa-fernwartung-b-'))
    try {
      await writeFile(join(anderes, 'fernwartung-status.json'), JSON.stringify({ ...GUELTIG, id: '555666777' }), 'utf8')
      await schreibe(GUELTIG)
      process.env.FERNWARTUNG_STATUS_DIR = anderes
      expect((await hole()).json()).toMatchObject({ eingerichtet: true, id: '555666777' })
    } finally {
      await rm(anderes, { recursive: true, force: true })
    }
  })

  it('gilt für die ganze Kasse, nicht je Mandant (anderer Mandant sieht dasselbe)', async () => {
    await schreibe(GUELTIG)
    const srv = await buildTestServer(keineDb)
    try {
      const res = await srv.fastify.inject({
        method: 'GET', url: '/api/system/fernwartung',
        headers: srv.authHeader({ mandantId: '99999999-0000-0000-0000-000000000009' }),
      })
      expect(res.json()).toMatchObject({ eingerichtet: true, id: '123456789' })
    } finally {
      await srv.close()
    }
  })

  it('es gibt keinen Schreib-Endpunkt (POST/PUT/PATCH/DELETE → 404)', async () => {
    const srv = await buildTestServer(keineDb)
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await srv.fastify.inject({
          method, url: '/api/system/fernwartung', headers: srv.authHeader(),
          payload: method === 'DELETE' ? undefined : GUELTIG,
        })
        expect(res.statusCode, method).toBe(404)
      }
    } finally {
      await srv.close()
    }
  })
})
