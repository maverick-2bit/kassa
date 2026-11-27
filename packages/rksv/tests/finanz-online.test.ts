/**
 * Unit-Tests für den FinanzOnline-Client gegen die ECHTE BMF-Schnittstelle.
 *
 * `fetch` wird ersetzt (helpers/fon-dienst.ts); geprüft werden Session-Flow (login → rkdb → logout), Endpunkte, SOAPAction,
 * die Werte in den Datensätzen (Begründungscodes, Seriennummern, Zeitangaben) und die Auswertung der Antworten (rc/msg/
 * abfrage_ergebnis, mehrere Ergebnisse und Meldungen, Fehlerfälle).
 *
 * Die Mock-ANTWORTEN stammen aus fixtures/fon-beispiele.ts und sind schema-gültig; am Ende dieser Datei wird jede Antwort,
 * die ausgeliefert wurde, noch einmal gegen die amtlichen Schemas geprüft. Ob die ANFRAGEN des Clients schema-gültig sind,
 * prüft fon-xsd.test.ts (libxml2) — hier geht es um das Verhalten.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { zertSeriennummerDezimal, type FinanzOnlineClient } from '../src/finanz-online.js'
import { generateSEE } from '../src/see.js'
import { parseRkdbAntwort, beschreibeRkdbFehler, paketNr } from '../src/fon/rkdb.js'
import { xsdDateTimeWien } from '../src/fon/datum.js'
import { xmlUnescape } from '../src/fon/soap.js'
import { FON_HERSTELLER_ID_PLATZHALTER } from '../src/fon/session.js'
import type { FinanzOnlineCredentials, KassenRegistrierung } from '../src/types.js'
import { validiereGegenXsd } from './helpers/xsd.js'
import { bedienteAntworten, mitDienst, standardAntworter, type Aufruf } from './helpers/fon-dienst.js'
import { ANTWORTEN, ergebnis as ergebnisXml, rkdbAntwort, BSP_SEE_SN_HEX } from './fixtures/fon-beispiele.js'

const credentials: FinanzOnlineCredentials = {
  teilnehmerId:    'TID12345',
  benutzerkennung: 'BENID1',
  pin:             'PIN12345',
  herstellerId:    'ATU12345678',
}

const xml = (name: string): string => ANTWORTEN[name]!.xml

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const arten = (aufrufe: Aufruf[]) => aufrufe.map(a => a.art)

async function neueRegistrierung(kassenId = 'REG-KASSE'): Promise<KassenRegistrierung> {
  const see = await generateSEE({ kassenId, uid: 'ATU12345678', firmenname: 'Reg GmbH' })
  return {
    kassenId, uid: 'ATU12345678', zertifikatDER: see.zertifikatDER, credentials,
    benutzerschluesselBase64: see.aesSchluessel.toString('base64'), vdaId: 'AT1', artSe: 'HSM_DIENSTLEISTER',
  }
}

describe('FinanzOnlineClient — Session-Flow', () => {
  it('login schickt tid/benid/pin/herstellerid als loginRequest an den Session-WS', async () => {
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, credentials))

    const login = aufrufe[0]!
    expect(login.url).toBe('https://finanzonline.bmf.gv.at/fonws/ws/session')
    expect(login.soapAction).toBe('"login"')
    expect(login.body).toMatch(/^<ses:loginRequest xmlns:ses="https:\/\/finanzonline\.bmf\.gv\.at\/fon\/ws\/session">/)
    expect(login.body).toContain('<ses:tid>TID12345</ses:tid>')
    expect(login.body).toContain('<ses:benid>BENID1</ses:benid>')
    expect(login.body).toContain('<ses:pin>PIN12345</ses:pin>')
    expect(login.body).toContain('<ses:herstellerid>ATU12345678</ses:herstellerid>')
  })

  it('rkdb nutzt die Session-ID und art_uebermittlung T (Testumgebung)', async () => {
    const { aufrufe } = await mitDienst(standardAntworter({ status_see: xml('status-see-aktiviert') }),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials))

    const rkdb = aufrufe[1]!
    expect(rkdb.url).toBe('https://finanzonline.bmf.gv.at/fonws/ws/rkdb')
    expect(rkdb.soapAction).toBe('"rkdb"')
    expect(rkdb.body).toContain('<rk:id>ABCDEF1234567890</rk:id>')
    expect(rkdb.body).toContain('<rk:tid>TID12345</rk:tid>')
    expect(rkdb.body).toContain('<rk:benid>BENID1</rk:benid>')
    expect(rkdb.body).toContain('<rk:art_uebermittlung>T</rk:art_uebermittlung>')
    expect(rkdb.body).toContain('<rk:status_see>')
  })

  it('Produktionsumgebung setzt art_uebermittlung P', async () => {
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, credentials), 'produktion')
    expect(aufrufe[1]!.body).toContain('<rk:art_uebermittlung>P</rk:art_uebermittlung>')
  })

  it('schließt die Session mit logoutRequest ab', async () => {
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'logout'])
    const logout = aufrufe[2]!
    expect(logout.soapAction).toBe('"logout"')
    expect(logout.body).toMatch(/^<ses:logoutRequest /)
    expect(logout.body).toContain('<ses:id>ABCDEF1234567890</ses:id>')
    expect(logout.body).toContain('<ses:tid>TID12345</ses:tid>')
  })

  it('meldet einen fehlgeschlagenen Login (rc ≠ 0) und fragt dann nichts mehr ab', async () => {
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter({ login: xml('login-fehler') }),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('Login')
    expect(ergebnis.fehler).toContain('-4')
    expect(ergebnis.fehler).toContain('Zugangsdaten falsch')
    expect(arten(aufrufe)).toEqual(['login'])
  })

  it('ein HTTP-Fehler (SOAP-Fault) beim Login kommt als Ergebnis zurück, nicht als Ausnahme', async () => {
    const { ergebnis } = await mitDienst(
      standardAntworter({ login: { status: 500, text: '<soap:Fault><faultstring>Schemafehler im Login</faultstring></soap:Fault>' } }),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('500')
    expect(ergebnis.fehler).toContain('Schemafehler im Login')
  })

  it('ein Netzfehler im rkdb-Aufruf kommt als Ergebnis zurück — und die Session wird trotzdem abgemeldet', async () => {
    const { aufrufe, ergebnis } = await mitDienst(
      standardAntworter({ status_see: new Error('connect ECONNREFUSED') }),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('nicht erreichbar')
    expect(ergebnis.fehler).toContain('ECONNREFUSED')
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'logout'])
  })

  it('ein Fehler beim Logout ist nicht fatal', async () => {
    const { ergebnis } = await mitDienst(
      standardAntworter({ status_see: xml('status-see-aktiviert'), logout: { status: 500, text: 'kaputt' } }),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis.erfolgreich).toBe(true)
  })

  it('escaped Sonderzeichen in den Zugangsdaten', async () => {
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, {
      teilnehmerId: 'a<b', benutzerkennung: 'c&d', pin: 'e>f', herstellerId: 'ATU12345678',
    }))
    const login = aufrufe[0]!.body
    expect(login).toContain('a&lt;b')
    expect(login).toContain('c&amp;d')
    expect(login).toContain('e&gt;f')
  })
})

describe('FinanzOnlineClient — Hersteller-ID', () => {
  const ohneHersteller: FinanzOnlineCredentials = { teilnehmerId: 'TID12345', benutzerkennung: 'BENID1', pin: 'PIN12345' }
  const herstellerImLogin = (a: Aufruf[]): string => /<ses:herstellerid>([^<]*)<\/ses:herstellerid>/.exec(a[0]!.body)![1]!

  it('Vorrang: Zugangsdaten vor Client-Einstellung vor Platzhalter', async () => {
    const mitCred = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, { ...ohneHersteller, herstellerId: 'ZUGANGSDATEN1' }), 'test', { herstellerId: 'EINSTELLUNG01' })
    expect(herstellerImLogin(mitCred.aufrufe)).toBe('ZUGANGSDATEN1')

    const mitOption = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, ohneHersteller), 'test', { herstellerId: 'EINSTELLUNG01' })
    expect(herstellerImLogin(mitOption.aufrufe)).toBe('EINSTELLUNG01')

    const keine = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, ohneHersteller))
    expect(herstellerImLogin(keine.aufrufe)).toBe(FON_HERSTELLER_ID_PLATZHALTER)
  })

  it('leere oder nur aus Leerraum bestehende Angaben zählen als „nicht gesetzt"', async () => {
    const r = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, { ...ohneHersteller, herstellerId: '   ' }), 'test', { herstellerId: '' })
    expect(herstellerImLogin(r.aufrufe)).toBe(FON_HERSTELLER_ID_PLATZHALTER)
  })

  it('eine ungültige Hersteller-ID wird gemeldet, BEVOR etwas gesendet wird', async () => {
    for (const falsch of ['ATU_KASSA_RKSV_0001', 'KURZ', 'A'.repeat(25), 'mit Leerzeichen']) {
      const r = await mitDienst(standardAntworter(), c => c.statusSe(BSP_SEE_SN_HEX, ohneHersteller), 'test', { herstellerId: falsch })
      expect(r.aufrufe, falsch).toEqual([])
      expect(r.ergebnis.erfolgreich).toBe(false)
      expect(r.ergebnis.fehler).toContain('Hersteller-ID')
    }
  })

  it('beim Platzhalter weist ein fehlgeschlagener Login auf die fehlende Hersteller-ID hin — mit eigener ID nicht', async () => {
    const abgelehnt = standardAntworter({ login: xml('login-fehler') })
    const platzhalter = await mitDienst(abgelehnt, c => c.statusSe(BSP_SEE_SN_HEX, ohneHersteller))
    expect(platzhalter.ergebnis.fehler).toContain('FON_HERSTELLER_ID')

    const eigene = await mitDienst(abgelehnt, c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(eigene.ergebnis.fehler).not.toContain('FON_HERSTELLER_ID')
  })
})

describe('FinanzOnlineClient — Registrierung (registrierung_se, dann registrierung_kasse)', () => {
  const seUnbekannt = standardAntworter({ status_see: xml('status-see-unbekannt') })

  it('meldet SE und Kasse in getrennten rkdb-Aufrufen mit den Feldnamen des Schemas', async () => {
    const reg = await neueRegistrierung()
    const { aufrufe, ergebnis } = await mitDienst(seUnbekannt, c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis).toEqual({ erfolgreich: true })
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'rkdb', 'rkdb', 'logout'])

    const dezimal = zertSeriennummerDezimal(reg.zertifikatDER)
    // 1. Statusabfrage: kennt FinanzOnline die SE schon?
    expect(aufrufe[1]!.body).toContain(`<rk:zertifikatsseriennummer>${dezimal}</rk:zertifikatsseriennummer>`)
    // 2. registrierung_se
    const se = aufrufe[2]!.body
    expect(se).toContain('<rk:registrierung_se>')
    expect(se).toContain('<rk:art_se>HSM_DIENSTLEISTER</rk:art_se>')
    expect(se).toContain('<rk:vda_id>AT1</rk:vda_id>')
    expect(se).toContain(`<rk:zertifikatsseriennummer>${dezimal}</rk:zertifikatsseriennummer>`)
    expect(se).not.toContain('registrierung_kasse')
    // 3. registrierung_kasse
    const kasse = aufrufe[3]!.body
    expect(kasse).toContain('<rk:registrierung_kasse>')
    expect(kasse).toContain('<rk:kassenidentifikationsnummer>REG-KASSE</rk:kassenidentifikationsnummer>')
    expect(kasse).toContain(`<rk:benutzerschluessel>${reg.benutzerschluesselBase64}</rk:benutzerschluessel>`)
    expect(kasse).not.toContain('registrierung_se')
  })

  it('Zertifikatsseriennummer wird dezimal übermittelt (Original-Kodierung laut BMF)', async () => {
    const see = await generateSEE({ kassenId: 'K', uid: 'ATU00000000', firmenname: 'X' })
    const dezimal = zertSeriennummerDezimal(see.zertifikatDER)
    expect(dezimal).toMatch(/^\d+$/)
    // hex != dezimal (sonst wäre die Umrechnung wirkungslos)
    const { X509Certificate } = await import('node:crypto')
    const hex = new X509Certificate(see.zertifikatDER).serialNumber
    expect(hex).not.toBe(dezimal)
    expect(BigInt(`0x${hex}`).toString(10)).toBe(dezimal)
  })

  it('kennt FinanzOnline die SE schon, wird sie nicht noch einmal gemeldet (Wiederholen nach einem Abbruch zwischen den Schritten)', async () => {
    const reg = await neueRegistrierung()
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter({ status_see: xml('status-see-aktiviert') }), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis).toEqual({ erfolgreich: true })
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'rkdb', 'logout'])
    expect(aufrufe[2]!.body).toContain('<rk:registrierung_kasse>')
  })

  it('scheitert die Vorabfrage technisch (SOAP-Fault), wird die SE trotzdem registriert — die Vorabfrage ist nie ein Hindernis', async () => {
    const reg = await neueRegistrierung()
    const { aufrufe, ergebnis } = await mitDienst(
      standardAntworter({ status_see: { status: 500, text: '<soap:Fault><faultstring>interner Fehler</faultstring></soap:Fault>' } }),
      c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis).toEqual({ erfolgreich: true })
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'rkdb', 'rkdb', 'logout'])
  })

  it('wird die SE abgelehnt, wird die Kasse nicht gemeldet', async () => {
    const reg = await neueRegistrierung()
    const antworter = standardAntworter({ status_see: xml('status-see-unbekannt'), rkdb: xml('rkdb-fehler') })
    const { aufrufe, ergebnis } = await mitDienst(antworter, c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('Signaturerstellungseinheit')
    expect(ergebnis.fehler).toContain('B20')
    expect(arten(aufrufe)).toEqual(['login', 'status_see', 'rkdb', 'logout'])
    expect(aufrufe[2]!.body).toContain('registrierung_se')
  })

  it('lehnt die Registrierung der Kasse bei rc ≠ 0 ab und nennt Code und Text', async () => {
    const reg = await neueRegistrierung('K')
    const abgelehnt = rkdbAntwort(ergebnisXml(1, '-42', 'Kasse bereits registriert'))
    const { ergebnis } = await mitDienst(standardAntworter({ status_see: xml('status-see-aktiviert'), rkdb: abgelehnt }), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('der Kasse')
    expect(ergebnis.fehler).toContain('-42')
    expect(ergebnis.fehler).toContain('bereits registriert')
  })

  it('eine bereits registrierte Kasse wird nie stillschweigend übernommen (anderer Benutzerschlüssel möglich)', async () => {
    const reg = await neueRegistrierung()
    const { aufrufe } = await mitDienst(standardAntworter({ status_see: xml('status-see-aktiviert') }), c => c.kasseInBetriebNehmen(reg))
    expect(aufrufe.some(a => a.art === 'status_kasse')).toBe(false)
  })

  it('AT0 (Software-Signatur) wird nicht gemeldet: kein Login, klare Meldung', async () => {
    const reg = { ...(await neueRegistrierung()), vdaId: 'AT0', artSe: 'EIGENES_HSM' as const }
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.kasseInBetriebNehmen(reg))
    expect(aufrufe).toEqual([])
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('AT0')
    expect(ergebnis.fehler).toContain('AT1 (A-Trust)')
  })

  it('eine ungültige Kennung des Vertrauensdiensteanbieters wird abgewiesen, ohne etwas zu senden', async () => {
    for (const falsch of ['at1', 'AT', 'ATU1', '', 'A1']) {
      const reg = { ...(await neueRegistrierung()), vdaId: falsch }
      const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.kasseInBetriebNehmen(reg))
      expect(aufrufe, `„${falsch}“`).toEqual([])
      expect(ergebnis.erfolgreich).toBe(false)
      expect(ergebnis.fehler).toContain('Vertrauensdiensteanbieters')
    }
    // zulässig laut BMF: A-Trust, GlobalTrust, PrimeSign
    for (const gut of ['AT1', 'AT2', 'AT3']) {
      const reg = { ...(await neueRegistrierung()), vdaId: gut }
      const { aufrufe } = await mitDienst(seUnbekannt, c => c.kasseInBetriebNehmen(reg))
      expect(aufrufe.length, gut).toBeGreaterThan(0)
    }
  })

  it('ein unlesbares Zertifikat wird gemeldet, ohne etwas zu senden', async () => {
    const reg = { ...(await neueRegistrierung()), zertifikatDER: Buffer.from('kein Zertifikat') }
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.kasseInBetriebNehmen(reg))
    expect(aufrufe).toEqual([])
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('Zertifikat')
  })
})

describe('FinanzOnlineClient — Status', () => {
  it('startbelegPruefen fragt status_kasse ab (REGISTRIERT = ok)', async () => {
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter({ status_kasse: xml('status-kasse-registriert') }),
      c => c.startbelegPruefen({} as never, credentials, 'STATUS-KASSE'))
    expect(ergebnis).toEqual({ erfolgreich: true, pruefwert: 'REGISTRIERT' })
    expect(aufrufe[1]!.body).toContain('<rk:status_kasse>')
    expect(aufrufe[1]!.body).toContain('<rk:kassenidentifikationsnummer>STATUS-KASSE</rk:kassenidentifikationsnummer>')
  })

  it('IN_BETRIEB ist ebenfalls ok', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_kasse: xml('status-kasse-in-betrieb') }),
      c => c.startbelegPruefen({} as never, credentials, 'K'))
    expect(ergebnis).toEqual({ erfolgreich: true, pruefwert: 'IN_BETRIEB' })
  })

  it('AUSFALL ist kein ok — der Status steht in der Meldung', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_kasse: xml('status-kasse-ausfall') }),
      c => c.startbelegPruefen({} as never, credentials, 'K'))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('AUSFALL')
  })

  it('eine abgelehnte Statusabfrage nennt Code und Text', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_kasse: xml('rkdb-fehler') }),
      c => c.startbelegPruefen({} as never, credentials, 'K'))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('B20')
  })

  it('ohne Kassen-ID gibt es nichts abzufragen: ok, ohne FinanzOnline anzusprechen', async () => {
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.startbelegPruefen({} as never, credentials))
    expect(ergebnis).toEqual({ erfolgreich: true })
    expect(aufrufe).toEqual([])
  })

  it('statusSe liefert den Status der SEE', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_see: xml('status-see-aktiviert') }), c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis).toEqual({ erfolgreich: true, pruefwert: 'AKTIVIERT' })
  })

  it('statusSe: eine unbekannte SEE ist ein Fehler mit dem Text von FinanzOnline (Zeichenverweis &#223; gelesen)', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_see: xml('status-see-unbekannt') }), c => c.statusSe(BSP_SEE_SN_HEX, credentials))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('V6')
    expect(ergebnis.fehler).toContain('außer Betrieb')
  })

  it('Seriennummern, die keine Hexadezimalzahl sind, werden abgewiesen, ohne etwas zu senden', async () => {
    for (const falsch of ['', 'SN-1', '0x01E240', 'G1', 'A'.repeat(51), ' 12']) {
      const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.statusSe(falsch, credentials))
      expect(aufrufe, `„${falsch}“`).toEqual([])
      expect(ergebnis.erfolgreich).toBe(false)
      expect(ergebnis.fehler).toContain('Seriennummer')
    }
  })
})

describe('FinanzOnlineClient — Meldungen (Ausfall, Wiederinbetriebnahme, Außerbetriebnahme)', () => {
  it('Außerbetriebnahme: ausfall_kasse + ausserbetriebnahme, Begründung 6 (planmäßig); 7 auf Wunsch', async () => {
    const standard = await mitDienst(standardAntworter(), c => c.kasseAusserBetriebNehmen('AB-KASSE', credentials))
    expect(standard.ergebnis).toEqual({ erfolgreich: true })
    expect(standard.aufrufe[1]!.body).toContain('<rk:ausfall_kasse>')
    expect(standard.aufrufe[1]!.body).toContain('<rk:kassenidentifikationsnummer>AB-KASSE</rk:kassenidentifikationsnummer>')
    expect(standard.aufrufe[1]!.body).toContain('<rk:ausserbetriebnahme><rk:begruendung>6</rk:begruendung></rk:ausserbetriebnahme>')
    // ein Zeitpunkt wird laut BMF nicht angegeben
    expect(standard.aufrufe[1]!.body).not.toContain('beginn_ausfall')

    const irreparabel = await mitDienst(standardAntworter(), c => c.kasseAusserBetriebNehmen('AB-KASSE', credentials, { begruendung: 7 }))
    expect(irreparabel.aufrufe[1]!.body).toContain('<rk:begruendung>7</rk:begruendung>')
  })

  it('SEE-Ausfall: Begründung 2, die Seriennummer hexadezimal mit hex="true", der Beginn in Wiener Zeit mit Abstand', async () => {
    const beginn = new Date('2026-07-01T08:00:00Z')
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials, { beginn }))
    expect(ergebnis).toEqual({ erfolgreich: true })
    const body = aufrufe[1]!.body
    expect(body).toContain('<rk:ausfall_se>')
    expect(body).toContain(`<rk:zertifikatsseriennummer hex="true">${BSP_SEE_SN_HEX}</rk:zertifikatsseriennummer>`)
    expect(body).toContain('<rk:ausfall><rk:begruendung>2</rk:begruendung><rk:beginn_ausfall>2026-07-01T10:00:00+02:00</rk:beginn_ausfall></rk:ausfall>')
  })

  it('SEE-Ausfall: ein anderer Begründungscode lässt sich vorgeben', async () => {
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials, { begruendung: 99 }))
    expect(aufrufe[1]!.body).toContain('<rk:begruendung>99</rk:begruendung>')
  })

  it('SEE-Ausfall ohne Beginn: jetzt; ein Beginn in der Zukunft wird auf jetzt begrenzt (laut BMF unzulässig)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T09:30:00Z'))

    const ohne = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials))
    expect(ohne.aufrufe[1]!.body).toContain('<rk:beginn_ausfall>2026-11-13T10:30:00+01:00</rk:beginn_ausfall>')

    const zukunft = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials, { beginn: new Date('2026-11-14T00:00:00Z') }))
    expect(zukunft.aufrufe[1]!.body).toContain('<rk:beginn_ausfall>2026-11-13T10:30:00+01:00</rk:beginn_ausfall>')

    const vergangen = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials, { beginn: new Date('2026-11-10T22:15:00Z') }))
    expect(vergangen.aufrufe[1]!.body).toContain('<rk:beginn_ausfall>2026-11-10T23:15:00+01:00</rk:beginn_ausfall>')
  })

  it('SEE-Wiederinbetriebnahme: ende_ausfall (Standard jetzt), Seriennummer hexadezimal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T09:30:00Z'))

    const jetzt = await mitDienst(standardAntworter(), c => c.seeWiederinbetriebnahmeMelden('KID', BSP_SEE_SN_HEX, credentials))
    expect(jetzt.ergebnis).toEqual({ erfolgreich: true })
    expect(jetzt.aufrufe[1]!.body).toContain('<rk:wiederinbetriebnahme_se>')
    expect(jetzt.aufrufe[1]!.body).toContain(`<rk:zertifikatsseriennummer hex="true">${BSP_SEE_SN_HEX}</rk:zertifikatsseriennummer>`)
    expect(jetzt.aufrufe[1]!.body).toContain('<rk:ende_ausfall>2026-11-13T10:30:00+01:00</rk:ende_ausfall>')

    const fest = await mitDienst(standardAntworter(), c => c.seeWiederinbetriebnahmeMelden('KID', BSP_SEE_SN_HEX, credentials, { ende: new Date('2026-11-12T06:00:00Z') }))
    expect(fest.aufrufe[1]!.body).toContain('<rk:ende_ausfall>2026-11-12T07:00:00+01:00</rk:ende_ausfall>')
  })

  it('jede Meldung trägt paket_nr (1 … 999 999 999) und ts_erstellung (Wiener Zeit mit Abstand) im rkdb-Kopf', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T09:30:00Z'))
    const { aufrufe } = await mitDienst(standardAntworter(), c => c.kasseAusserBetriebNehmen('K', credentials))
    expect(aufrufe[1]!.body).toContain('<rk:rkdb><rk:paket_nr>562201795</rk:paket_nr><rk:ts_erstellung>2026-11-13T10:30:00+01:00</rk:ts_erstellung>')
    expect(aufrufe[1]!.body).toContain('<rk:satznr>1</rk:satznr>')
  })

  it('eine abgelehnte Meldung nennt Code und Text (alphanumerischer Code, maskierte Zeichen im Text gelesen)', async () => {
    for (const aktion of [
      (c: FinanzOnlineClient) => c.seeAusfallMelden('KID', BSP_SEE_SN_HEX, credentials),
      (c: FinanzOnlineClient) => c.seeWiederinbetriebnahmeMelden('KID', BSP_SEE_SN_HEX, credentials),
      (c: FinanzOnlineClient) => c.kasseAusserBetriebNehmen('KID', credentials),
    ]) {
      const { ergebnis } = await mitDienst(standardAntworter({ rkdb: xml('rkdb-fehler') }), aktion)
      expect(ergebnis.erfolgreich).toBe(false)
      expect(ergebnis.fehler).toContain('B20')
      expect(ergebnis.fehler).toContain('<AUSFALL>')
      expect(ergebnis.fehler).toContain('bereits gesetzt & wird ignoriert')
    }
  })

  it('Seriennummern, die keine Hexadezimalzahl sind, werden bei Ausfall und Wiederinbetriebnahme abgewiesen', async () => {
    const a = await mitDienst(standardAntworter(), c => c.seeAusfallMelden('KID', 'SN-1', credentials))
    const w = await mitDienst(standardAntworter(), c => c.seeWiederinbetriebnahmeMelden('KID', 'SN-1', credentials))
    for (const r of [a, w]) {
      expect(r.aufrufe).toEqual([])
      expect(r.ergebnis.erfolgreich).toBe(false)
      expect(r.ergebnis.fehler).toContain('Seriennummer')
    }
  })
})

describe('Auswertung der Antworten (parseRkdbAntwort)', () => {
  it('Erfolg nur, wenn JEDE Meldung JEDES Ergebnisses rc 0 hat', () => {
    expect(parseRkdbAntwort(xml('rkdb-ok')).erfolgreich).toBe(true)
    expect(parseRkdbAntwort(xml('rkdb-zweiter-datensatz-abgelehnt')).erfolgreich).toBe(false)
    expect(parseRkdbAntwort(xml('rkdb-mehrere-meldungen')).erfolgreich).toBe(false)
  })

  it('liefert alle Ergebnisblöcke und Meldungen in der Reihenfolge der Antwort', () => {
    const e = parseRkdbAntwort(xml('rkdb-zweiter-datensatz-abgelehnt'))
    expect(e.ergebnisse.map(s => s.satznr)).toEqual(['1', '2'])
    expect(e.ergebnisse[1]!.meldungen).toEqual([{ rc: '-42', msg: 'Kasse bereits registriert' }])
    expect(e.rc).toBe('-42')

    const m = parseRkdbAntwort(xml('rkdb-mehrere-meldungen'))
    expect(m.ergebnisse).toHaveLength(1)
    expect(m.ergebnisse[0]!.meldungen.map(x => x.rc)).toEqual(['0', '-7'])
    expect(m.rc).toBe('-7')
    expect(m.msg).toBe('Zertifikat unbekannt')
  })

  it('der Fehlertext nennt ALLE fehlgeschlagenen Meldungen, nicht die erfolgreichen', () => {
    const zwei = rkdbAntwort(ergebnisXml(1, 'B1', 'erster Fehler') + ergebnisXml(2, '0', 'ok') + ergebnisXml(3, 'V6', 'zweiter Fehler'))
    expect(beschreibeRkdbFehler(parseRkdbAntwort(zwei))).toBe('(rc B1): erster Fehler; (rc V6): zweiter Fehler')
  })

  it('rc ist ein Text: alphanumerische Codes (B14, V6) und negative Zahlen bleiben unverändert', () => {
    const e = parseRkdbAntwort(rkdbAntwort(ergebnisXml(1, 'B14', 'x')))
    expect(e.rc).toBe('B14')
    expect(e.erfolgreich).toBe(false)
    // „0" ist der einzige Erfolg — „00" ist es nicht
    expect(parseRkdbAntwort(rkdbAntwort(ergebnisXml(1, '00', 'x'))).erfolgreich).toBe(false)
  })

  it('liest den Status aus abfrage_ergebnis/status (Kinder ohne Namespace), samt Zeitpunkten', () => {
    const e = parseRkdbAntwort(xml('status-kasse-registriert'))
    expect(e.abfrageErgebnis).toBe('REGISTRIERT')
    expect(e.ergebnisse[0]!.status).toEqual({ tsRegistrierung: '2026-11-01T10:00:00', status: 'REGISTRIERT', tsStatus: '2026-11-01T10:00:00' })
    expect(parseRkdbAntwort(xml('rkdb-ok')).abfrageErgebnis).toBeUndefined()
  })

  it('kommt mit Präfix, Standard-Namespace und beliebigen Präfixnamen zurecht', () => {
    expect(parseRkdbAntwort(xml('status-kasse-standardnamespace')).abfrageErgebnis).toBe('IN_BETRIEB')
    const anders = xml('status-kasse-registriert').replace(/rk:/g, 'ns2:').replace('xmlns:rk=', 'xmlns:ns2=')
    expect(parseRkdbAntwort(anders).abfrageErgebnis).toBe('REGISTRIERT')
  })

  it('liest Zeichenverweise im Text (&amp; &lt; &gt; &quot; &apos; &#223; &#xDF;)', () => {
    expect(xmlUnescape('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#223;&#xDF;')).toBe('a & b <c> "d" \'e\' ßß')
    // in EINEM Durchgang: &amp;lt; wird zu &lt;, nicht zu <
    expect(xmlUnescape('&amp;lt;')).toBe('&lt;')
    // Unbekanntes bleibt stehen
    expect(xmlUnescape('&unbekannt; &#0; &#xFFFFFF;')).toBe('&unbekannt; &#0; &#xFFFFFF;')
  })

  // Absichtlich NICHT schema-gültig (Objektform: wird nicht als Schema-Mock geprüft): alles, was keine verwertbare Antwort ist, ist kein Erfolg.
  it('eine Antwort ohne Ergebnis (Wartungsseite, leere Antwort, abgeschnittenes XML) ist KEIN Erfolg', () => {
    for (const schlecht of ['', '<html><body>Wartungsarbeiten</body></html>', '<rk:rkdbResponse xmlns:rk="x"></rk:rkdbResponse>', '<rk:result><rk:satznr>1']) {
      const e = parseRkdbAntwort(schlecht)
      expect(e.erfolgreich, schlecht).toBe(false)
      expect(e.ergebnisse, schlecht).toEqual([])
      expect(beschreibeRkdbFehler(e)).toContain('nicht auswertbar')
    }
  })

  it('ein Ergebnis ohne Meldung ist KEIN Erfolg (es fehlt der ausdrückliche rc 0)', () => {
    const e = parseRkdbAntwort('<rk:rkdbResponse xmlns:rk="x"><rk:result><rk:satznr>3</rk:satznr></rk:result></rk:rkdbResponse>')
    expect(e.erfolgreich).toBe(false)
    expect(beschreibeRkdbFehler(e)).toContain('Satz 3')
  })

  it('eine unbrauchbare Antwort des Dienstes macht jede Aktion zum Fehlschlag, nie zum Erfolg', async () => {
    const wartung = { status: 200, text: '<html><body>FinanzOnline: Wartungsarbeiten</body></html>' }
    const reg = await neueRegistrierung()
    const aktionen: ((c: FinanzOnlineClient) => Promise<{ erfolgreich: boolean }>)[] = [
      c => c.kasseInBetriebNehmen(reg),
      c => c.kasseAusserBetriebNehmen('K', credentials),
      c => c.seeAusfallMelden('K', BSP_SEE_SN_HEX, credentials),
      c => c.seeWiederinbetriebnahmeMelden('K', BSP_SEE_SN_HEX, credentials),
      c => c.statusSe(BSP_SEE_SN_HEX, credentials),
      c => c.startbelegPruefen({} as never, credentials, 'K'),
    ]
    for (const aktion of aktionen) {
      const { ergebnis } = await mitDienst(standardAntworter({ status_see: wartung, status_kasse: wartung, rkdb: wartung }), aktion)
      expect(ergebnis.erfolgreich).toBe(false)
    }
  })
})

describe('Zeit- und Paketangaben', () => {
  it('xs:dateTime in Wiener Ortszeit mit Abstand — Winter +01:00, Sommer +02:00, unabhängig von TZ', () => {
    expect(xsdDateTimeWien(new Date('2026-11-13T09:30:00Z'))).toBe('2026-11-13T10:30:00+01:00')
    expect(xsdDateTimeWien(new Date('2026-07-01T08:00:00Z'))).toBe('2026-07-01T10:00:00+02:00')
  })

  it('Zeitumstellung: Frühjahr (Sprung 02:00 → 03:00) und Herbst (die Stunde 02:xx kommt zweimal, mit verschiedenem Abstand)', () => {
    expect(xsdDateTimeWien(new Date('2026-03-29T00:59:59Z'))).toBe('2026-03-29T01:59:59+01:00')
    expect(xsdDateTimeWien(new Date('2026-03-29T01:00:00Z'))).toBe('2026-03-29T03:00:00+02:00')
    expect(xsdDateTimeWien(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25T02:30:00+02:00')
    expect(xsdDateTimeWien(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T02:30:00+01:00')
  })

  it('Jahreswechsel: UTC-Silvester ist in Wien schon Neujahr', () => {
    expect(xsdDateTimeWien(new Date('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:59:59+01:00')
  })

  it('Sekunden werden abgeschnitten, nicht gerundet (wie die Wanduhr)', () => {
    expect(xsdDateTimeWien(new Date('2026-11-13T09:30:00.999Z'))).toBe('2026-11-13T10:30:00+01:00')
  })

  it('paket_nr liegt immer in 1 … 999 999 999', () => {
    for (const t of [0, 1, 999_999_998, 999_999_999, 1_000_000_000, 1_794_562_200_000, 4_102_444_800_000]) {
      const n = paketNr(new Date(t))
      expect(n, String(t)).toBeGreaterThanOrEqual(1)
      expect(n, String(t)).toBeLessThanOrEqual(999_999_999)
      expect(Number.isInteger(n)).toBe(true)
    }
    expect(paketNr(new Date('2026-11-13T09:30:00Z'))).toBe(562_201_795)
  })
})

// ---------------------------------------------------------------------------
// Zum Schluss: die Mocks selbst
// ---------------------------------------------------------------------------

describe('Die Mock-Antworten dieser Datei', () => {
  it('sind alle schema-gültig (Mocks, die es nicht sind, haben die Befunde F-1 … F-11 lange verdeckt)', async () => {
    const faelle = [...bedienteAntworten].map(([xmlText, schema], i) => ({ name: `mock-${i}`, schema, xml: xmlText }))
    expect(faelle.length, 'es wurden Antworten ausgeliefert').toBeGreaterThanOrEqual(8)
    const urteile = await validiereGegenXsd(faelle)
    for (const f of faelle) expect(urteile.get(f.name)!.fehler, f.xml.slice(0, 160)).toEqual([])
  }, 30_000)
})
