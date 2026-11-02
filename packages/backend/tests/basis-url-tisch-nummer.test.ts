/**
 * Kleinteile der Sicherheitsprüfung 2026-11: Link-Adresse aus der Konfiguration, Tischnummer aus öffentlichen Routen.
 */

import { describe, it, expect } from 'vitest'
import { oeffentlicheBasisUrl } from '../src/services/basis-url.js'
import { TischNummerSchema } from '../src/routes/tisch-nummer.js'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

describe('oeffentlicheBasisUrl (Links in Mails an Gäste)', () => {
  it.each([
    ['http://192.168.1.50',                       'http://192.168.1.50'],
    ['https://kasse.example.com',                  'https://kasse.example.com'],
    ['https://kasse.example.com/',                 'https://kasse.example.com'],
    ['https://kasse.example.com/irgendein/pfad?x', 'https://kasse.example.com'],
    ['  https://a.example.com , http://b.example.com ', 'https://a.example.com'],      // erster Eintrag zählt
    ['*, https://kasse.example.com',               'https://kasse.example.com'],        // Platzhalter überspringen
    ['http://localhost:5173',                      'http://localhost:5173'],
  ])('%s → %s', (cors, erwartet) => {
    expect(oeffentlicheBasisUrl({ CORS_ORIGIN: cors })).toBe(erwartet)
  })

  it.each([['*'], [''], ['kein url'], ['javascript:alert(1)'], ['ftp://example.com']])('%j → keine Adresse', (cors) => {
    expect(oeffentlicheBasisUrl({ CORS_ORIGIN: cors })).toBeNull()
  })
})

describe('TischNummerSchema (öffentliche Gast-Bestellung)', () => {
  it.each(['Tisch 5', 'T12', 'Terrasse 3', 'Bar-2/Ecke', 'A-7', 'Tisch 5 (Fenster)', 'Gästetisch äöü', '#14', '1', 'Raum 2: Tisch 4'])
  ('%j ist gültig', (wert) => {
    expect(TischNummerSchema.safeParse(wert).success).toBe(true)
  })

  it('schneidet Leerraum am Rand ab', () => {
    expect(TischNummerSchema.parse('  Tisch 5  ')).toBe('Tisch 5')
  })

  it.each([
    ['Zeilenumbruch',            'Tisch 5\nTisch 6'],
    ['ESC (Druckerbefehl)',      'T\x1bp\x00\x19\xfa'],
    ['GS (Druckerbefehl)',       'T\x1dV\x00'],
    ['NUL',                      'T\x00'],
    ['Rechts-nach-links',        'Tisch ‮5'],
    ['HTML',                     '<script>alert(1)</script>'],
    ['Backtick',                 'Tisch `5`'],
    ['Backslash',                'Tisch\\5'],
    ['leer',                     ''],
    ['nur Leerraum',             '   '],
    ['zu lang (41 Zeichen)',     'x'.repeat(41)],
  ])('%s wird abgelehnt', (_name, wert) => {
    expect(TischNummerSchema.safeParse(wert).success).toBe(false)
  })
})

describe('POST /api/gast/bestellung: ungültige Tischnummer', () => {
  // Die Prüfung liegt vor jedem Datenbankzugriff — eine Attrappe genügt
  const mockDb = { select: () => { throw new Error('darf nicht erreicht werden') } } as unknown as Db

  it('Befehle in der Tischnummer → 400, bevor irgendetwas gespeichert oder gedruckt wird', async () => {
    const srv = await buildTestServer(mockDb)
    try {
      for (const tischNummer of ['T\x1bp\x00\x19', 'Tisch\n1', '<b>1</b>']) {
        const res = await srv.fastify.inject({
          method: 'POST', url: '/api/gast/bestellung',
          payload: {
            kasseId: '10000000-0000-4000-8000-000000000001', tischNummer,
            positionen: [{ artikelId: '20000000-0000-4000-8000-000000000001', menge: 1 }],
          },
        })
        expect(res.statusCode, JSON.stringify(tischNummer)).toBe(400)
      }
    } finally {
      await srv.close()
    }
  })
})
