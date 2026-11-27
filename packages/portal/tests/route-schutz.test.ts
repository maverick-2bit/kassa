/**
 * Schutz-Netz: jede Route des Portals und ihr Schutz stehen HIER ausdrücklich. Kommt eine Route dazu (oder verliert eine
 * ihren Wächter), schlägt dieser Test an — ein Verwaltungsportal darf nichts versehentlich offen lassen.
 */

import { describe, it, expect } from 'vitest'
import type { Db } from '../src/db/client.js'
import { loadConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'
import type { Waechter } from '../src/auth/jwt.js'

const config = loadConfig({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  PORTAL_JWT_SECRET: 'j'.repeat(40),
  PORTAL_MASTER_KEY: 'm'.repeat(40),
  NODE_ENV: 'test',
})

/** Erwartete Routen: Schutz = Sitzung ('portal'), Einrichtungs-Token ('totp-setup'), 'oeffentlich' (bewusst offen) */
const ERWARTET: Record<string, 'portal' | 'totp-setup' | 'oeffentlich'> = {
  'GET /api/health':                    'oeffentlich',   // Lebenszeichen für Docker/Caddy, ohne Daten
  'POST /api/auth/anmelden':            'oeffentlich',   // die Anmeldung selbst (begrenzt, sperrt nach Fehlversuchen)
  'POST /api/auth/totp/einrichten':     'totp-setup',
  'POST /api/auth/totp/bestaetigen':    'totp-setup',
  'GET /api/ich':                       'portal',
  'POST /api/box/meldung':              'oeffentlich',   // Box-Token im Handler (nur Hash gespeichert), kein Benutzer-Login
  'GET /api/uebersicht':                'portal',
  'POST /api/betriebe':                 'portal',
  'PATCH /api/betriebe/:id':            'portal',
  'POST /api/betriebe/:id/boxen':       'portal',
  'GET /api/boxen/:id':                 'portal',
  'PATCH /api/boxen/:id':               'portal',
  'POST /api/boxen/:id/token-erneuern': 'portal',
}

describe('Routen-Schutz des Portals', () => {
  it('alle Routen und ihr Schutz entsprechen genau der Tabelle', async () => {
    const register: { method: string | string[]; url: string; onRequest: unknown }[] = []
    const server = await buildServer({ config, db: {} as Db, routenRegister: register })
    await server.ready()

    const gefunden: Record<string, string> = {}
    for (const r of register) {
      for (const method of [r.method].flat()) {
        if (method === 'HEAD' || method === 'OPTIONS') continue // von Fastify automatisch zu GET-Routen ergänzt
        const hooks = (Array.isArray(r.onRequest) ? r.onRequest : r.onRequest ? [r.onRequest] : []) as Waechter[]
        const schutz = hooks.map(h => h.portalSchutz).find(Boolean)
        gefunden[`${method} ${r.url}`] = schutz ?? 'oeffentlich'
      }
    }
    expect(gefunden).toEqual(ERWARTET)
    await server.close()
  })
})
