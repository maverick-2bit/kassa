/**
 * Die Hersteller-ID der Installation (Einstellung FON_HERSTELLER_ID) kommt beim FinanzOnline-Login an.
 *
 * `erzeugeFinanzOnlineClient` ist die EINE Stelle, an der die Kassa einen echten FinanzOnline-Client anlegt (SEE-Ausfall,
 * Wiederinbetriebnahme, Kassen-Außerbetriebnahme, Nachtrag der Registrierung). Die Integrationstests dieser Abläufe
 * arbeiten mit Mock-Clients und sehen den Login nicht — hier wird `fetch` ersetzt und der Login-Request gelesen.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { FinanzOnlineClient, FON_HERSTELLER_ID_PLATZHALTER } from '@kassa/rksv'
import { erzeugeFinanzOnlineClient } from '../src/services/beleg.service.js'

const ZUGANG = { teilnehmerId: 'TID12345', benutzerkennung: 'BENID1', pin: 'PIN12345' }

const LOGIN_OK  = '<ses:loginResponse xmlns:ses="https://finanzonline.bmf.gv.at/fon/ws/session"><ses:id>ABCDEF1234567890</ses:id><ses:rc>0</ses:rc></ses:loginResponse>'
const LOGOUT_OK = '<ses:logoutResponse xmlns:ses="https://finanzonline.bmf.gv.at/fon/ws/session"><ses:rc>0</ses:rc></ses:logoutResponse>'
const RKDB_OK   = '<rk:rkdbResponse xmlns:rk="https://finanzonline.bmf.gv.at/rkdb"><rk:paket_nr>1</rk:paket_nr><rk:ts_erstellung>2026-11-13T10:00:00</rk:ts_erstellung>' +
                  '<rk:result><rk:satznr>1</rk:satznr><rk:rkdbMessage><rk:rc>0</rk:rc><rk:msg>ok</rk:msg></rk:rkdbMessage></rk:result></rk:rkdbResponse>'

/** Ersetzt `fetch` und liefert die Bodys der gesendeten Anfragen zurück. */
function ersetzeFetch(): string[] {
  const bodys: string[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: { body: string }) => {
    bodys.push(init.body)
    const text = init.body.includes('loginRequest') ? LOGIN_OK : init.body.includes('logoutRequest') ? LOGOUT_OK : RKDB_OK
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) })
  }))
  return bodys
}

const herstellerImLogin = (bodys: string[]): string =>
  /<ses:herstellerid>([^<]*)<\/ses:herstellerid>/.exec(bodys.find(b => b.includes('loginRequest'))!)![1]!

afterEach(() => vi.unstubAllGlobals())

describe('erzeugeFinanzOnlineClient', () => {
  it('ein eingespritzter Client (Stub, Mock) wird unverändert verwendet', () => {
    const eingespritzt = { statusSe: vi.fn() } as unknown as FinanzOnlineClient
    expect(erzeugeFinanzOnlineClient({ finanzOnlineClient: eingespritzt, fonHerstellerId: 'ATU12345678' }, 'test')).toBe(eingespritzt)
  })

  it('die Hersteller-ID der Installation steht im Login', async () => {
    const bodys = ersetzeFetch()
    await erzeugeFinanzOnlineClient({ fonHerstellerId: 'ATU12345678' }, 'test').statusSe('01E240', ZUGANG)
    expect(herstellerImLogin(bodys)).toBe('ATU12345678')
  })

  it('ohne eingestellte Hersteller-ID gilt der Platzhalter (schema-gültig, aber erkennbar kein echter Wert)', async () => {
    const bodys = ersetzeFetch()
    await erzeugeFinanzOnlineClient({}, 'test').statusSe('01E240', ZUGANG)
    expect(herstellerImLogin(bodys)).toBe(FON_HERSTELLER_ID_PLATZHALTER)
    expect(herstellerImLogin(bodys)).toMatch(/^[0-9A-Za-z]{10,24}$/)
  })

  it('in den Zugangsdaten mitgegebene Hersteller-ID hat Vorrang vor der Einstellung', async () => {
    const bodys = ersetzeFetch()
    await erzeugeFinanzOnlineClient({ fonHerstellerId: 'EINSTELLUNG01' }, 'test').statusSe('01E240', { ...ZUGANG, herstellerId: 'ZUGANGSDATEN1' })
    expect(herstellerImLogin(bodys)).toBe('ZUGANGSDATEN1')
  })

  it('Umgebung der Kasse: test → art_uebermittlung T, alles andere → P', async () => {
    for (const [umgebung, erwartet] of [['test', 'T'], ['produktion', 'P'], ['irgendwas', 'P']] as const) {
      const bodys = ersetzeFetch()
      await erzeugeFinanzOnlineClient({ fonHerstellerId: 'ATU12345678' }, umgebung).statusSe('01E240', ZUGANG)
      const rkdb = bodys.find(b => b.includes('rkdbRequest'))!
      expect(rkdb, umgebung).toContain(`<rk:art_uebermittlung>${erwartet}</rk:art_uebermittlung>`)
      vi.unstubAllGlobals()
    }
  })
})
