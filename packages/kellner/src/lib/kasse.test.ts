import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuth } from './auth'
import { getKasseIdentity, setKasseIdentity, uebernimmEinrichtungsLink } from './kasse'

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

const BETRIEB_A = '11111111-1111-4111-8111-111111111111'
const BETRIEB_B = '22222222-2222-4222-8222-222222222222'
const KASSE_A   = '33333333-3333-4333-8333-333333333333'

function angemeldetBeiBetriebA() {
  setKasseIdentity({ mandantId: BETRIEB_A, kasseId: KASSE_A })
  localStorage.setItem('kellner:token', 'token-a')
  localStorage.setItem('kellner:auth', JSON.stringify({ user: { name: 'A' }, mandant: { id: BETRIEB_A }, kassen: [] }))
}

beforeEach(() => { vi.stubGlobal('localStorage', fakeLocalStorage()) })

describe('uebernimmEinrichtungsLink — Einrichtungs-QR eines anderen Betriebs', () => {
  it('anderer Betrieb: Zuordnung UND Anmeldung weichen, das Handy richtet sich neu ein', () => {
    angemeldetBeiBetriebA()
    expect(uebernimmEinrichtungsLink(`?mandantId=${BETRIEB_B}`)).toBe(true)
    expect(getKasseIdentity()).toBeNull()
    expect(getAuth()).toBeNull()
  })

  it('derselbe Betrieb (auch in anderer Schreibweise): nichts passiert — Start über den Link bleibt angemeldet', () => {
    angemeldetBeiBetriebA()
    expect(uebernimmEinrichtungsLink(`?mandantId=${BETRIEB_A.toUpperCase()}`)).toBe(false)
    expect(getKasseIdentity()).toEqual({ mandantId: BETRIEB_A, kasseId: KASSE_A })
    expect(getAuth()).not.toBeNull()
  })

  it('ohne Link (Start über das Home-Bildschirm-Symbol) bleibt alles, wie es ist', () => {
    angemeldetBeiBetriebA()
    expect(uebernimmEinrichtungsLink('')).toBe(false)
    expect(uebernimmEinrichtungsLink('?foo=bar')).toBe(false)
    expect(getKasseIdentity()).not.toBeNull()
    expect(getAuth()).not.toBeNull()
  })

  it('unbrauchbare mandantId im Link (kein GUID): wird nicht als Einrichtung gedeutet', () => {
    angemeldetBeiBetriebA()
    expect(uebernimmEinrichtungsLink('?mandantId=abc')).toBe(false)
    expect(uebernimmEinrichtungsLink('?mandantId=')).toBe(false)
    expect(getKasseIdentity()).not.toBeNull()
  })

  it('Handy ohne Zuordnung: nichts zu verwerfen', () => {
    expect(uebernimmEinrichtungsLink(`?mandantId=${BETRIEB_B}`)).toBe(false)
    expect(getKasseIdentity()).toBeNull()
  })
})
