import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginResponse } from '@kassa/shared'
import { aktiveSitzung, aktiviereSitzung, clearAuth, getAuth, getGeraetToken, setAuth, setGeraetToken, verlasseSitzung } from './auth'
import { getKasseIdentity, setKasseIdentity } from './kasse'
import { ladeKonten } from './konten'
import { sichereAktivesKonto, sichereKasseNachAnmeldung } from './kontoWechsel'

/** Anmeldeantwort mit genau den Feldern, die auth.ts und konten.ts lesen. */
function login(mandant: string, opt: { admin?: boolean; kassen?: string[]; geraet?: string } = {}): LoginResponse {
  const admin = opt.admin ?? true
  return {
    token: `token-${mandant}`,
    ...(opt.geraet ? { geraetToken: opt.geraet } : {}),
    user: { name: `Benutzer ${mandant}`, rolle: admin ? 'admin' : 'kellner', berechtigungen: admin ? ['einstellungen'] : ['kasse'] },
    mandant: { id: mandant, firmenname: `Firma ${mandant}`, pinLaenge: 4 },
    kassen: (opt.kassen ?? [`${mandant}-k1`]).map(id => ({ id, kassenId: id.toUpperCase(), bezeichnung: null, umgebung: 'test' })),
  } as unknown as LoginResponse
}

describe('Anmeldung und Abmeldung pflegen die Konten dieses Geräts', () => {
  const daten = new Map<string, string>()
  beforeEach(() => {
    daten.clear()
    vi.stubGlobal('localStorage', {
      getItem:    (k: string) => daten.get(k) ?? null,
      setItem:    (k: string, v: string) => { daten.set(k, v) },
      removeItem: (k: string) => { daten.delete(k) },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const sitzungen = () => ladeKonten().map(k => [k.mandantId, k.sitzung?.token ?? null])

  it('Admin A, dann Admin B: A liegt zur Seite, B ist aktiv — und die Kasse des Geräts steht im Konto', () => {
    setAuth(login('a', { kassen: ['a1', 'a2'] }))
    setKasseIdentity({ mandantId: 'a', kasseId: 'a2' })
    setAuth(login('b'))
    expect(getAuth()?.mandant.id).toBe('b')
    expect(sitzungen()).toEqual([['a', 'token-a'], ['b', null]])
    expect(ladeKonten()[0]).toMatchObject({ mandantId: 'a', kasseId: 'a2' })
  })

  it('Abmelden verwirft alle gemerkten Sitzungen — die Konten bleiben', () => {
    setAuth(login('a'))
    setAuth(login('b'))
    clearAuth()
    expect(getAuth()).toBeNull()
    expect(sitzungen()).toEqual([['a', null], ['b', null]])
  })

  it('eine Anmeldung ohne Einstellungs-Recht verwirft alles und legt die bisherige Sitzung nicht ab', () => {
    setAuth(login('a'))
    setAuth(login('b'))                                   // A liegt zur Seite
    setAuth(login('b', { admin: false }))                 // ein Kassier meldet sich an
    expect(sitzungen()).toEqual([['a', null], ['b', null]])
  })

  it('aktiviereSitzung und verlasseSitzung (Mandanten-Wechsel) lassen die Konten-Liste in Ruhe', () => {
    setAuth(login('a'))
    setAuth(login('b'))
    const vorher = sitzungen()
    verlasseSitzung()
    expect(getAuth()).toBeNull()
    expect(sitzungen()).toEqual(vorher)
    aktiviereSitzung(login('a'))
    expect(getAuth()?.mandant.id).toBe('a')
    expect(sitzungen()).toEqual(vorher)
  })

  it('aktiveSitzung: die Sitzung samt Kasse dieses Geräts; ohne Anmeldung null', () => {
    expect(aktiveSitzung()).toBeNull()
    setAuth(login('a'))
    setKasseIdentity({ mandantId: 'a', kasseId: 'a-k1' })
    expect(aktiveSitzung()).toMatchObject({ kasseId: 'a-k1', sitzung: { token: 'token-a', mandant: { id: 'a' } } })
  })

  it('das Geräte-Merkmal je Mandant: setzen und entfernen', () => {
    setGeraetToken('g-a')
    expect(getGeraetToken()).toBe('g-a')
    setGeraetToken(null)
    expect(getGeraetToken()).toBeUndefined()
  })

  it('sichereAktivesKonto nimmt eine Anmeldung aus der Zeit vor dem Merken auf, ohne gemerkte Sitzungen anzufassen', () => {
    // eine ältere Installation: angemeldet, Kasse gesetzt, aber noch keine Konten-Liste
    daten.set('kassa:token', 'token-a')
    daten.set('kassa:auth', JSON.stringify({ user: login('a').user, mandant: login('a').mandant, kassen: login('a', { kassen: ['a1', 'a2'] }).kassen }))
    setKasseIdentity({ mandantId: 'a', kasseId: 'a2' })
    expect(ladeKonten()).toHaveLength(0)                  // noch keine Konten-Liste (setKasseIdentity kennt das Konto nicht)
    sichereAktivesKonto()
    expect(ladeKonten()).toMatchObject([{ mandantId: 'a', firmenname: 'Firma a', kasseId: 'a2', sitzung: null }])
    const stand = daten.get('kassa:konten')
    sichereAktivesKonto()                                  // unverändert: nichts neu geschrieben
    expect(daten.get('kassa:konten')).toBe(stand)
  })

  it('sichereKasseNachAnmeldung: behält die gewählte Kasse, sonst die zuletzt benutzte dieses Mandanten, sonst die erste', () => {
    const a = login('a', { kassen: ['a1', 'a2'] })
    setAuth(a)
    setKasseIdentity({ mandantId: 'a', kasseId: 'a2' })
    sichereKasseNachAnmeldung(a)                           // a2 gehört dem Benutzer → bleibt
    expect(getKasseIdentity()?.kasseId).toBe('a2')

    // ein anderer Mandant: das Gerät steht noch auf einer Kasse von A → B bekommt seine erste Kasse
    const b = login('b', { kassen: ['b1', 'b2'] })
    setAuth(b)
    sichereKasseNachAnmeldung(b)
    expect(getKasseIdentity()).toEqual({ mandantId: 'b', kasseId: 'b1' })

    // später wieder A: die zuletzt benutzte Kasse (a2) kommt zurück, nicht die erste
    setAuth(a)
    sichereKasseNachAnmeldung(a)
    expect(getKasseIdentity()).toEqual({ mandantId: 'a', kasseId: 'a2' })
  })
})
