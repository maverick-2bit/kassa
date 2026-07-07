/**
 * Unit-Tests für den FinanzOnline-Client gegen die ECHTE BMF-Schnittstelle.
 *
 * global.fetch wird gemockt; geprüft werden Session-Flow (login → rkdb → logout),
 * Endpunkte, SOAPAction, Feldnamen der Datensätze (registrierung_se/-kasse,
 * status_kasse) und die Auswertung des Antwort-Codes (rc/msg/abfrage_ergebnis).
 * Feldnamen stammen aus session.xsd + regKasse.xsd.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { FinanzOnlineClient, zertSeriennummerDezimal } from '../src/finanz-online.js'
import { generateSEE } from '../src/see.js'
import type { FinanzOnlineCredentials, KassenRegistrierung } from '../src/types.js'

const credentials: FinanzOnlineCredentials = {
  teilnehmerId:    'TID12345',
  benutzerkennung: 'BENID1',
  pin:             'PIN12345',
  herstellerId:    'HERSTELLER-TEST-01',
}

const LOGIN_OK  = '<login:loginResponse xmlns:login="x"><id>SESSION-XYZ</id><rc>0</rc></login:loginResponse>'
const LOGOUT_OK = '<logoutResponse><rc>0</rc></logoutResponse>'

/** Reihen-Mock: gibt der Reihe nach die angegebenen XML-Antworten zurück. */
function mockFetchSequenz(...responses: string[]) {
  let i = 0
  const fetchMock = vi.fn().mockImplementation(() => {
    const xml = responses[Math.min(i, responses.length - 1)]!
    i++
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(xml) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function body(call: [string, { body: string }]): string { return call[1].body }
function url(call: [string]): string { return call[0] }

afterEach(() => vi.unstubAllGlobals())

describe('FinanzOnlineClient — Session-Flow', () => {
  it('login schickt tid/benid/pin/herstellerid an den Session-WS', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc></result>', LOGOUT_OK)
    await new FinanzOnlineClient('test').statusSe('SN', credentials)

    const loginCall = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    expect(url(loginCall)).toBe('https://finanzonline.bmf.gv.at/fonws/ws/session')
    expect(loginCall[1].headers['SOAPAction']).toBe('"login"')
    expect(body(loginCall)).toContain('<fon:tid>TID12345</fon:tid>')
    expect(body(loginCall)).toContain('<fon:benid>BENID1</fon:benid>')
    expect(body(loginCall)).toContain('<fon:pin>PIN12345</fon:pin>')
    expect(body(loginCall)).toContain('<fon:herstellerid>HERSTELLER-TEST-01</fon:herstellerid>')
  })

  it('rkdb nutzt die Session-ID und art_uebermittlung T (Testumgebung)', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc><abfrage_ergebnis>AKTIVIERT</abfrage_ergebnis></result>', LOGOUT_OK)
    await new FinanzOnlineClient('test').statusSe('SN-1', credentials)

    const rkdbCall = fetchMock.mock.calls[1] as [string, { body: string; headers: Record<string, string> }]
    expect(url(rkdbCall)).toBe('https://finanzonline.bmf.gv.at/fonws/ws/rkdb')
    expect(rkdbCall[1].headers['SOAPAction']).toBe('"rkdb"')
    expect(body(rkdbCall)).toContain('<rk:id>SESSION-XYZ</rk:id>')
    expect(body(rkdbCall)).toContain('<rk:art_uebermittlung>T</rk:art_uebermittlung>')
    expect(body(rkdbCall)).toContain('<rk:status_se>')
    expect(body(rkdbCall)).toContain('<zertifikatsseriennummer>SN-1</zertifikatsseriennummer>')
  })

  it('Produktionsumgebung setzt art_uebermittlung P', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc></result>', LOGOUT_OK)
    await new FinanzOnlineClient('produktion').statusSe('SN', credentials)
    expect(body(fetchMock.mock.calls[1] as [string, { body: string }])).toContain('<rk:art_uebermittlung>P</rk:art_uebermittlung>')
  })

  it('schließt die Session mit logout ab', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc></result>', LOGOUT_OK)
    await new FinanzOnlineClient('test').statusSe('SN', credentials)

    const logoutCall = fetchMock.mock.calls[2] as [string, { body: string; headers: Record<string, string> }]
    expect(logoutCall[1].headers['SOAPAction']).toBe('"logout"')
    expect(body(logoutCall)).toContain('<fon:id>SESSION-XYZ</fon:id>')
  })

  it('meldet einen fehlgeschlagenen Login (rc != 0)', async () => {
    mockFetchSequenz('<loginResponse><rc>-1</rc><msg>Zugangsdaten falsch</msg></loginResponse>')
    const res = await new FinanzOnlineClient('test').statusSe('SN', credentials)
    expect(res.erfolgreich).toBe(false)
    expect(res.fehler).toContain('Login')
    expect(res.fehler).toContain('Zugangsdaten falsch')
  })
})

describe('FinanzOnlineClient — Registrierung (registrierung_se + registrierung_kasse)', () => {
  it('sendet beide Datensätze mit den Spec-Feldnamen', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><satznr>1</satznr><rkdbMessage><rc>0</rc></rkdbMessage></result>', LOGOUT_OK)
    const see = await generateSEE({ kassenId: 'REG-KASSE', uid: 'ATU12345678', firmenname: 'Reg GmbH' })

    const reg: KassenRegistrierung = {
      kassenId:      'REG-KASSE',
      uid:           'ATU12345678',
      zertifikatDER: see.zertifikatDER,
      credentials,
      benutzerschluesselBase64: see.aesSchluessel.toString('base64'),
      vdaId:         'AT1',
      artSe:         'HSM_DIENSTLEISTER',
    }
    const res = await new FinanzOnlineClient('test').kasseInBetriebNehmen(reg)
    expect(res.erfolgreich).toBe(true)

    const rkdbBody = body(fetchMock.mock.calls[1] as [string, { body: string }])
    // registrierung_se
    expect(rkdbBody).toContain('<registrierung_se>')
    expect(rkdbBody).toContain('<art_se>HSM_DIENSTLEISTER</art_se>')
    expect(rkdbBody).toContain('<vda_id>AT1</vda_id>')
    expect(rkdbBody).toContain(`<zertifikatsseriennummer>${zertSeriennummerDezimal(see.zertifikatDER)}</zertifikatsseriennummer>`)
    // registrierung_kasse
    expect(rkdbBody).toContain('<registrierung_kasse>')
    expect(rkdbBody).toContain('<kassenidentifikationsnummer>REG-KASSE</kassenidentifikationsnummer>')
    expect(rkdbBody).toContain(`<benutzerschluessel>${see.aesSchluessel.toString('base64')}</benutzerschluessel>`)
  })

  it('Zertifikatsseriennummer wird dezimal übermittelt (FON-Vorgabe)', async () => {
    const see = await generateSEE({ kassenId: 'K', uid: 'ATU00000000', firmenname: 'X' })
    const dezimal = zertSeriennummerDezimal(see.zertifikatDER)
    expect(dezimal).toMatch(/^\d+$/)
    // hex != dezimal (sonst wäre die Umrechnung wirkungslos)
    const { X509Certificate } = await import('node:crypto')
    expect(new X509Certificate(see.zertifikatDER).serialNumber).not.toBe(dezimal)
  })

  it('lehnt Registrierung bei rc != 0 ab', async () => {
    mockFetchSequenz(LOGIN_OK, '<result><rkdbMessage><rc>-42</rc><msg>Kasse bereits registriert</msg></rkdbMessage></result>', LOGOUT_OK)
    const see = await generateSEE({ kassenId: 'K', uid: 'ATU00000000', firmenname: 'X' })
    const res = await new FinanzOnlineClient('test').kasseInBetriebNehmen({
      kassenId: 'K', uid: 'ATU00000000', zertifikatDER: see.zertifikatDER, credentials,
      benutzerschluesselBase64: see.aesSchluessel.toString('base64'), vdaId: 'AT1', artSe: 'HSM_DIENSTLEISTER',
    })
    expect(res.erfolgreich).toBe(false)
    expect(res.fehler).toContain('-42')
    expect(res.fehler).toContain('bereits registriert')
  })
})

describe('FinanzOnlineClient — Status + Escaping', () => {
  it('startbelegPruefen fragt status_kasse ab (REGISTRIERT = ok)', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc><abfrage_ergebnis>REGISTRIERT</abfrage_ergebnis></result>', LOGOUT_OK)
    const res = await new FinanzOnlineClient('test').startbelegPruefen({} as never, credentials, 'STATUS-KASSE')
    expect(res.erfolgreich).toBe(true)
    expect(res.pruefwert).toBe('REGISTRIERT')
    expect(body(fetchMock.mock.calls[1] as [string, { body: string }])).toContain('<kassenidentifikationsnummer>STATUS-KASSE</kassenidentifikationsnummer>')
  })

  it('escaped Sonderzeichen in den Zugangsdaten', async () => {
    const fetchMock = mockFetchSequenz(LOGIN_OK, '<result><rc>0</rc></result>', LOGOUT_OK)
    await new FinanzOnlineClient('test').statusSe('SN', {
      teilnehmerId: 'a<b', benutzerkennung: 'c&d', pin: 'e>f',
    })
    const loginBody = body(fetchMock.mock.calls[0] as [string, { body: string }])
    expect(loginBody).toContain('a&lt;b')
    expect(loginBody).toContain('c&amp;d')
    expect(loginBody).toContain('e&gt;f')
  })
})
