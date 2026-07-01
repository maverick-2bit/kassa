/**
 * Unit-Tests für die SEE-Ausfall-/Wiederinbetriebnahme-Meldungen des
 * FinanzOnline-Clients. Der SOAP-Aufruf wird über einen gemockten global.fetch
 * abgefangen; geprüft werden Request-Aufbau (SOAPAction, Body-Felder) und die
 * Auswertung des Antwort-Codes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { FinanzOnlineClient } from '../src/finanz-online.js'
import type { FinanzOnlineCredentials } from '../src/types.js'

const credentials: FinanzOnlineCredentials = {
  teilnehmerId:    'TID-1',
  benutzerkennung: 'BEN-1',
  pin:             'PIN-1',
}

function mockFetch(responseXml: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(responseXml),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const RESPONSE_OK    = '<rksv:Response><rksv:Code>000</rksv:Code></rksv:Response>'
const RESPONSE_FEHLER = '<rksv:Response><rksv:Code>013</rksv:Code><rksv:Info>SEE unbekannt</rksv:Info></rksv:Response>'

afterEach(() => vi.unstubAllGlobals())

describe('FinanzOnlineClient — SEE-Ausfall melden', () => {
  it('sendet die richtige SOAPAction und die Felder im Body', async () => {
    const fetchMock = mockFetch(RESPONSE_OK)
    const client = new FinanzOnlineClient('test')

    const res = await client.seeAusfallMelden('KASSE-42', 'SN-999', credentials)

    expect(res.erfolgreich).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://finanzonline-test.bmf.gv.at/fon/ws/rksv/')
    expect((init.headers as Record<string, string>)['SOAPAction'])
      .toBe('"https://finanzonline.bmf.gv.at/fon/ws/rksv/SEEAusfall"')
    expect(init.body).toContain('<rksv:SEEAusfall>')
    expect(init.body).toContain('<rksv:KassenID>KASSE-42</rksv:KassenID>')
    expect(init.body).toContain('<rksv:SeriennummerZertifikat>SN-999</rksv:SeriennummerZertifikat>')
    expect(init.body).toContain('<rksv:TID>TID-1</rksv:TID>')
  })

  it('meldet Fehler bei einem Code ungleich 000', async () => {
    mockFetch(RESPONSE_FEHLER)
    const res = await new FinanzOnlineClient('test').seeAusfallMelden('K', 'SN', credentials)
    expect(res.erfolgreich).toBe(false)
    expect(res.fehler).toContain('013')
    expect(res.fehler).toContain('SEE unbekannt')
  })
})

describe('FinanzOnlineClient — Wiederinbetriebnahme melden', () => {
  it('nutzt die SEEWiederinbetriebnahme-Operation', async () => {
    const fetchMock = mockFetch(RESPONSE_OK)
    const res = await new FinanzOnlineClient('produktion')
      .seeWiederinbetriebnahmeMelden('KASSE-7', 'SN-1', credentials)

    expect(res.erfolgreich).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://finanzonline.bmf.gv.at/fon/ws/rksv/')
    expect((init.headers as Record<string, string>)['SOAPAction'])
      .toBe('"https://finanzonline.bmf.gv.at/fon/ws/rksv/SEEWiederinbetriebnahme"')
    expect(init.body).toContain('<rksv:SEEWiederinbetriebnahme>')
    expect(init.body).toContain('<rksv:KassenID>KASSE-7</rksv:KassenID>')
  })

  it('escaped Sonderzeichen in den Zugangsdaten', async () => {
    const fetchMock = mockFetch(RESPONSE_OK)
    await new FinanzOnlineClient('test').seeAusfallMelden('K&1', 'SN', {
      teilnehmerId: 'a<b', benutzerkennung: 'c&d', pin: 'e>f',
    })
    const body = fetchMock.mock.calls[0]![1].body as string
    expect(body).toContain('K&amp;1')
    expect(body).toContain('a&lt;b')
    expect(body).toContain('c&amp;d')
    expect(body).toContain('e&gt;f')
  })
})
