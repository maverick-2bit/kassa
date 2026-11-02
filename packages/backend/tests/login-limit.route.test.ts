/**
 * Anmelde-Bremse: Anmeldungen je Minute und Client-IP (POST /api/auth/login, /pin-login).
 *
 * Standard 10 (Brute-Force-Schutz; die Wirkung hinter nginx prüft integration/rate-limit.test.ts). Einstellbar über
 * LOGIN_RATE_LIMIT_MAX, damit der E2E-Lauf — 143 Tests in wenigen Minuten von EINER IP — nicht in die eigene Bremse
 * läuft (sonst fielen ältere Specs bei 429 in den Setup-Rückfall).
 */

import { describe, it, expect } from 'vitest'
import { buildTestServer } from './helpers/testServer.js'
import type { Db } from '../src/db/client.js'

// Kein Benutzer vorhanden → 401. Das Limit zählt vor dem Handler, die Antwort des Handlers ist hier egal.
const mockDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
} as unknown as Db

async function anmeldungen(max: number | undefined, anzahl: number): Promise<number[]> {
  const srv = await buildTestServer(mockDb, max === undefined ? {} : { config: { LOGIN_RATE_LIMIT_MAX: max } })
  try {
    const status: number[] = []
    for (let i = 0; i < anzahl; i++) {
      // verschiedene E-Mails: die Kontosperre (5 Fehlversuche je E-Mail) soll das Ergebnis nicht verfälschen
      const res = await srv.fastify.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: `nutzer${i}@limit.at`, passwort: 'irgendwas' },
      })
      status.push(res.statusCode)
    }
    return status
  } finally {
    await srv.close()
  }
}

describe('Anmelde-Bremse', () => {
  it('Standard: die elfte Anmeldung innerhalb einer Minute wird gebremst (429)', async () => {
    const status = await anmeldungen(undefined, 11)
    expect(status.slice(0, 10).every(s => s !== 429)).toBe(true)
    expect(status[10]).toBe(429)
  })

  it('LOGIN_RATE_LIMIT_MAX wirkt: bei 3 ist die vierte Anmeldung dran', async () => {
    const status = await anmeldungen(3, 4)
    expect(status.slice(0, 3).every(s => s !== 429)).toBe(true)
    expect(status[3]).toBe(429)
  })

  it('hochgestellt (E2E) bremst auch die zwanzigste Anmeldung nicht', async () => {
    const status = await anmeldungen(1000, 20)
    expect(status.filter(s => s === 429)).toHaveLength(0)
  })
})
