import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, authApi, setOnUnauthorized, systemApi } from './api'
import { getAuth } from './auth'
import { getKasseIdentity, setKasseIdentity } from './kasse'

/** localStorage gibt es unter vitest (node) nicht — ein Speicher aus einer Map genügt. */
function fakeLocalStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear:      () => m.clear(),
    getItem:    (k) => m.get(k) ?? null,
    key:        (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem:    (k, v) => { m.set(k, String(v)) },
  }
}

const BETRIEB = '11111111-1111-4111-8111-111111111111'
const KASSE   = '33333333-3333-4333-8333-333333333333'

function angemeldet() {
  setKasseIdentity({ mandantId: BETRIEB, kasseId: KASSE })
  localStorage.setItem('kellner:token', 'token')
  localStorage.setItem('kellner:auth', JSON.stringify({ user: { name: 'Kellner' }, mandant: { id: BETRIEB }, kassen: [] }))
}

function antwortet(status: number, body: unknown = { fehler: 'x' }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => { vi.stubGlobal('localStorage', fakeLocalStorage()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('401 der Kassa', () => {
  it('abgelaufene Anmeldung: nur die ANMELDUNG weicht — die Zuordnung zur Kassa bleibt, die Login-Seite wird angesteuert', async () => {
    angemeldet()
    antwortet(401, { fehler: 'Authentifizierung erforderlich' })
    const zumLogin = vi.fn()
    setOnUnauthorized(zumLogin)

    await expect(systemApi.health()).rejects.toThrow('Sitzung abgelaufen')

    expect(getAuth()).toBeNull()
    expect(getKasseIdentity()).toEqual({ mandantId: BETRIEB, kasseId: KASSE })
    expect(zumLogin).toHaveBeenCalledOnce()
  })

  it('falsche PIN (401 beim PIN-Login): weder Anmeldung noch Zuordnung werden angetastet, kein Wechsel zur Login-Seite', async () => {
    angemeldet()
    antwortet(401, { fehler: 'PIN ungültig' })
    const zumLogin = vi.fn()
    setOnUnauthorized(zumLogin)

    const fehler = await authApi.pinLogin({ kasseId: KASSE, pin: '1234' }).catch((e: unknown) => e)

    expect(fehler).toBeInstanceOf(ApiError)
    expect((fehler as ApiError).status).toBe(401)
    expect(getAuth()).not.toBeNull()
    expect(getKasseIdentity()).not.toBeNull()
    expect(zumLogin).not.toHaveBeenCalled()
  })

  it('unbekannte Kasse bei pin-info (404): ApiError mit Status — daran erkennt die Login-Seite eine veraltete Zuordnung', async () => {
    angemeldet()
    antwortet(404, { fehler: 'Kasse nicht gefunden' })

    const fehler = await authApi.pinInfo(KASSE).catch((e: unknown) => e)

    expect(fehler).toBeInstanceOf(ApiError)
    expect((fehler as ApiError).status).toBe(404)
  })
})
