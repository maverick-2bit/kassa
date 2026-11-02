/**
 * EXTERNE GEGENPROBE: FinanzOnline-Client gegen die amtlichen Schemas des BMF.
 *
 * Die Unit-Tests in finanz-online.test.ts mocken `fetch` und prüfen nur, ob bestimmte Zeichenketten
 * im Request vorkommen — ob der Dienst die Nachricht annehmen würde, sagen sie nicht. Hier werden die
 * Requests, die der Client wirklich erzeugt, mit libxml2 gegen session.xsd / regKasseWs.xsd geprüft
 * (Schemas unverändert in fixtures/fon-xsd, Quelle und Prüfsummen dort).
 *
 * STAND (Befunde F-1 … F-11, Beschreibung in PRUEFSTRECKE.md): Der Client erzeugt heute KEINEN
 * schema-gültigen Request. Diese Befunde sind als `it.fails` festgehalten — sie laufen grün, solange der
 * Mangel besteht, und werden rot („Expect test to fail"), sobald jemand den Client repariert: dann das
 * `.fails` an der Stelle entfernen. Die Soll-Beispiele (fixtures/fon-beispiele.ts) zeigen, wie die
 * Nachrichten aussehen müssen; sie werden hier selbst gegen die Schemas geprüft.
 *
 * Alle Details der Verstöße ausgeben:  FON_XSD_BEFUNDE=1 pnpm exec vitest run tests/fon-xsd.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FinanzOnlineClient, zertSeriennummerDezimal } from '../src/finanz-online.js'
import { generateSEE } from '../src/see.js'
import type { FinanzOnlineCredentials, KassenRegistrierung } from '../src/types.js'
import { validiereGegenXsd, FON_XSD_ORDNER, type FonSchema, type XsdErgebnis, type XsdFall } from './helpers/xsd.js'
import {
  ANTWORTEN, SOLL_ANFRAGEN, NS_RKDB, NS_SESSION,
  BSP_AES_B64, BSP_BENID, BSP_HERSTELLER, BSP_KASSE, BSP_SEE_SN, BSP_SESSION_ID, BSP_TID,
} from './fixtures/fon-beispiele.js'

// ---------------------------------------------------------------------------
// Hilfsfunktionen: Requests des Clients mitschneiden
// ---------------------------------------------------------------------------

interface Aufruf { url: string; soapAction: string; envelope: string; body: string; schema: FonSchema }

/** Zugangsdaten, die für sich schema-gültig sind — Mängel sollen aus dem Client kommen, nicht aus Testdaten. */
const ZUGANG: FinanzOnlineCredentials = {
  teilnehmerId: BSP_TID, benutzerkennung: BSP_BENID, pin: 'geheim123', herstellerId: BSP_HERSTELLER,
}

/**
 * Ersetzt `fetch` und liefert der Reihe nach die angegebenen Antworten (Login, rkdb, Logout).
 * Mitgeschnitten wird der komplette SOAP-Umschlag und der Inhalt von `soap:Body` (= die Nachricht, die das Schema meint).
 */
async function mitDienst<T>(antworten: readonly string[], aktion: (c: FinanzOnlineClient) => Promise<T>): Promise<{ aufrufe: Aufruf[]; ergebnis: T }> {
  const aufrufe: Aufruf[] = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: { body: string; headers: Record<string, string> }) => {
    const antwort = antworten[Math.min(i, antworten.length - 1)]!
    i++
    const body = /<soap:Body>([\s\S]*)<\/soap:Body>/.exec(init.body)?.[1]
    if (body === undefined) throw new Error(`Kein soap:Body im Umschlag: ${init.body.slice(0, 200)}`)
    aufrufe.push({ url, soapAction: init.headers['SOAPAction']!, envelope: init.body, body, schema: url.endsWith('/session') ? 'session' : 'rkdb' })
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(antwort) })
  }))
  try {
    return { aufrufe, ergebnis: await aktion(new FinanzOnlineClient('test')) }
  } finally {
    vi.unstubAllGlobals()
  }
}

const OK = [ANTWORTEN['login-ok']!.xml, ANTWORTEN['rkdb-ok']!.xml, ANTWORTEN['logout-ok']!.xml]
const mitAntwort = (rkdbAntwort: string) => [ANTWORTEN['login-ok']!.xml, rkdbAntwort, ANTWORTEN['logout-ok']!.xml]

afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------------------
// Einmal alles prüfen (ein Aufruf je Schema — schnell)
// ---------------------------------------------------------------------------

const faelle: XsdFall[] = []
let pruefung: Map<string, XsdErgebnis>
const urteil = (name: string): XsdErgebnis => {
  const e = pruefung.get(name)
  if (!e) throw new Error(`Fall ${name} wurde nicht geprüft`)
  return e
}

/** Kopien der Soll-Beispiele mit gezielt eingebautem Fehler (Gegenproben für den Validator). */
const FEHLERHAFT: Record<string, { schema: FonSchema; xml: string }> = {
  'hersteller-mit-unterstrich': {
    schema: 'session',
    xml: SOLL_ANFRAGEN['login']!.xml.replace(BSP_HERSTELLER, 'ATU_KASSA_RKSV_0001'),
  },
  'rkdb-ohne-paketnummer': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-kasse']!.xml.replace('<rk:paket_nr>1</rk:paket_nr>', ''),
  },
  'rkdb-element-ohne-namespace': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-kasse']!.xml.replace(/<(\/?)rk:kassenidentifikationsnummer>/g, '<$1kassenidentifikationsnummer>'),
  },
  'rkdb-se-und-kasse-gemeinsam': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['registrierung-se']!.xml.replace('</rk:rkdb>',
      /<rk:registrierung_kasse>[\s\S]*<\/rk:registrierung_kasse>/.exec(SOLL_ANFRAGEN['registrierung-kasse']!.xml)![0] + '</rk:rkdb>'),
  },
  'vda-id-at0': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['registrierung-se']!.xml.replace('<rk:vda_id>AT1</rk:vda_id>', '<rk:vda_id>AT0</rk:vda_id>'),
  },
  'benutzerschluessel-zu-kurz': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['registrierung-kasse']!.xml.replace(BSP_AES_B64, BSP_AES_B64.slice(0, 40)),
  },
  'art-uebermittlung-klein': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-kasse']!.xml.replace('>T</rk:art_uebermittlung>', '>t</rk:art_uebermittlung>'),
  },
  'status-se-statt-status-see': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-see']!.xml.replace(/rk:status_see>/g, 'rk:status_se>'),
  },
  'antwort-abfrage-ergebnis-als-text': {
    schema: 'rkdb',
    xml: ANTWORTEN['status-kasse-registriert']!.xml.replace(/<rk:abfrage_ergebnis>[\s\S]*<\/rk:abfrage_ergebnis>/, '<rk:abfrage_ergebnis>REGISTRIERT</rk:abfrage_ergebnis>'),
  },
}

/** Was der Client heute sendet — je Operation Login, rkdb, Logout. */
const clientAufrufe: Record<string, Aufruf[]> = {}

beforeAll(async () => {
  const see = await generateSEE({ kassenId: BSP_KASSE, uid: 'ATU12345678', firmenname: 'XSD GmbH' })
  const reg: KassenRegistrierung = {
    kassenId: BSP_KASSE, uid: 'ATU12345678', zertifikatDER: see.zertifikatDER, credentials: ZUGANG,
    benutzerschluesselBase64: see.aesSchluessel.toString('base64'), vdaId: 'AT1', artSe: 'HSM_DIENSTLEISTER',
  }
  const operationen: Record<string, (c: FinanzOnlineClient) => Promise<unknown>> = {
    'status-se':          c => c.statusSe(BSP_SEE_SN, ZUGANG),
    'registrierung':      c => c.kasseInBetriebNehmen(reg),
    'status-kasse':       c => c.startbelegPruefen({} as never, ZUGANG, BSP_KASSE),
    'ausserbetriebnahme': c => c.kasseAusserBetriebNehmen(BSP_KASSE, ZUGANG),
    'ausfall-se':         c => c.seeAusfallMelden(BSP_KASSE, BSP_SEE_SN, ZUGANG),
    'wiederinbetriebnahme-se': c => c.seeWiederinbetriebnahmeMelden(BSP_KASSE, BSP_SEE_SN, ZUGANG),
  }
  for (const [name, aktion] of Object.entries(operationen)) {
    const { aufrufe } = await mitDienst(OK, aktion)
    clientAufrufe[name] = aufrufe
    aufrufe.forEach((a, i) => faelle.push({ name: `client-${name}-${i}`, schema: a.schema, xml: a.body }))
  }
  // Standard-Hersteller-ID: Login ohne eigene herstellerId
  const { aufrufe: ohneHersteller } = await mitDienst(OK, c =>
    c.statusSe(BSP_SEE_SN, { teilnehmerId: BSP_TID, benutzerkennung: BSP_BENID, pin: 'geheim123' }))
  clientAufrufe['standard-hersteller'] = ohneHersteller

  // Soll-Beispiele + Gegenproben + Antworten
  for (const [name, b] of Object.entries(SOLL_ANFRAGEN)) faelle.push({ name: `soll-${name}`, schema: b.schema, xml: b.xml })
  for (const [name, b] of Object.entries(ANTWORTEN))     faelle.push({ name: `antwort-${name}`, schema: b.schema, xml: b.xml })
  for (const [name, b] of Object.entries(FEHLERHAFT))    faelle.push({ name: `fehlerhaft-${name}`, schema: b.schema, xml: b.xml })

  // Werte der Kassa in einem sonst gültigen Soll-Request: Seriennummer dezimal, AES-Schlüssel als Base64
  faelle.push({
    name: 'soll-mit-werten-der-kassa-se', schema: 'rkdb',
    xml: SOLL_ANFRAGEN['registrierung-se']!.xml.replace(BSP_SEE_SN, zertSeriennummerDezimal(see.zertifikatDER)),
  })
  faelle.push({
    name: 'soll-mit-werten-der-kassa-kasse', schema: 'rkdb',
    xml: SOLL_ANFRAGEN['registrierung-kasse']!.xml.replace(BSP_AES_B64, see.aesSchluessel.toString('base64')),
  })
  // Standard-Hersteller-ID des Clients in einem sonst gültigen loginRequest
  const standardHersteller = /<fon:herstellerid>([^<]*)<\/fon:herstellerid>/.exec(clientAufrufe['standard-hersteller']![0]!.body)![1]!
  faelle.push({
    name: 'soll-mit-standard-hersteller', schema: 'session',
    xml: SOLL_ANFRAGEN['login']!.xml.replace(BSP_HERSTELLER, standardHersteller),
  })

  pruefung = await validiereGegenXsd(faelle)
}, 60_000)

afterAll(() => {
  if (!process.env.FON_XSD_BEFUNDE) return
  for (const f of faelle.filter(x => x.name.startsWith('client-') || x.name === 'soll-mit-standard-hersteller')) {
    const e = pruefung.get(f.name)!
    console.log(`\n[${e.gueltig ? 'gültig ' : 'UNGÜLTIG'}] ${f.name}\n  ${f.xml.slice(0, 260)}${f.xml.length > 260 ? ' …' : ''}`)
    for (const m of e.fehler) console.log(`    - ${m}`)
  }
})

// ---------------------------------------------------------------------------
// 1) Fixtures + Validator
// ---------------------------------------------------------------------------

describe('Schema-Fixtures (unverändert wie vom BMF geladen)', () => {
  const summen = readFileSync(join(FON_XSD_ORDNER, 'SHA256SUMS'), 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map(z => { const [hash, name] = z.split(/\s+/); return { hash: hash!, name: name! } })

  it('SHA256SUMS listet alle sechs Dateien', () => {
    expect(summen.map(s => s.name).sort()).toEqual(
      ['regKasse.xsd', 'regKasseService.wsdl', 'regKasseWs.xsd', 'session.xsd', 'sessionService.wsdl', 'verification.xsd'])
  })

  it.each(summen)('$name entspricht der Prüfsumme', ({ hash, name }) => {
    const ist = createHash('sha256').update(readFileSync(join(FON_XSD_ORDNER, name))).digest('hex')
    expect(ist).toBe(hash)
  })
})

describe('Validator-Kontrolle (damit „gültig" nicht nichtssagend ist)', () => {
  it.each(Object.keys(SOLL_ANFRAGEN))('Soll-Request %s ist schema-gültig', name => {
    expect(urteil(`soll-${name}`).fehler).toEqual([])
    expect(urteil(`soll-${name}`).gueltig).toBe(true)
  })

  it.each(Object.keys(ANTWORTEN))('Antwort-Beispiel %s ist schema-gültig', name => {
    expect(urteil(`antwort-${name}`).fehler).toEqual([])
  })

  // Jede Gegenprobe baut genau EINEN Fehler in ein gültiges Beispiel ein — und muss abgelehnt werden.
  const gegenproben: [string, RegExp][] = [
    ['hersteller-mit-unterstrich',        /herstellerid.*(pattern|not accepted)/i],
    ['rkdb-ohne-paketnummer',             /paket_nr|not expected|Missing child/i],
    ['rkdb-element-ohne-namespace',       /not expected/i],
    ['rkdb-se-und-kasse-gemeinsam',       /registrierung_kasse.*not expected/i],
    ['vda-id-at0',                        /vda_id.*(pattern|not accepted)/i],
    ['benutzerschluessel-zu-kurz',        /benutzerschluessel.*(length|pattern|not accepted)/i],
    ['art-uebermittlung-klein',           /art_uebermittlung.*(enumeration|not accepted|valid)/i],
    ['status-se-statt-status-see',        /status_se.*not expected/i],
    ['antwort-abfrage-ergebnis-als-text', /abfrage_ergebnis.*(not accepted|Character content|not expected|element only)/i],
  ]
  it.each(gegenproben)('Gegenprobe %s wird abgelehnt', (name, muster) => {
    const e = urteil(`fehlerhaft-${name}`)
    expect(e.gueltig, `${name} hätte abgelehnt werden müssen`).toBe(false)
    expect(e.fehler.join('\n')).toMatch(muster)
  })

  it('Werte, die die Kassa erzeugt, passen in die Schema-Muster (Seriennummer dezimal, AES-Schlüssel Base64)', () => {
    expect(urteil('soll-mit-werten-der-kassa-se').fehler).toEqual([])
    expect(urteil('soll-mit-werten-der-kassa-kasse').fehler).toEqual([])
  })
})

describe('Vertragsdetails aus dem Schema (Befund: Software-SEE nicht als SE meldbar)', () => {
  // F-11: Die Software-SEE der Kassa trägt die ZDA-Kennung AT0. Das Schema lässt für `registrierung_se` nur
  // vda_id [A-Z]{2}[1-9][0-9]? zu — AT0 ist ausgeschlossen. Eine Software-SEE wird laut Schema als geschlossenes
  // Gesamtsystem gemeldet (registrierung_ggs, art_se_ggs SW_GGS).
  it('vda_id AT0 ist als registrierung_se nicht zulässig', () => {
    expect(urteil('fehlerhaft-vda-id-at0').gueltig).toBe(false)
  })
  it('registrierung_ggs mit SW_GGS ist der vorgesehene Weg für eine Software-Signatur', () => {
    expect(urteil('soll-registrierung-ggs').gueltig).toBe(true)
  })
  // F-6: Je rkdb-Aufruf genau EINE Art von Datensatz (xs:choice) — Kasse und SEE brauchen getrennte Aufrufe.
  it('registrierung_se und registrierung_kasse dürfen nicht im selben rkdb stehen', () => {
    expect(urteil('fehlerhaft-rkdb-se-und-kasse-gemeinsam').gueltig).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2) Endpunkte und SOAPAction gegen die WSDL
// ---------------------------------------------------------------------------

describe('Endpunkte und SOAPAction entsprechen den WSDL-Dateien', () => {
  const wsdl = (datei: string) => readFileSync(join(FON_XSD_ORDNER, datei), 'utf8')
  const adresse = (w: string) => /soap:address location="([^"]+)"/.exec(w)![1]!.replace(':443', '')
  const aktionen = (w: string) => [...w.matchAll(/soap:operation soapAction="([^"]*)"/g)].map(m => m[1]!).sort()

  it('Session-Dienst: Adresse login/logout', () => {
    const w = wsdl('sessionService.wsdl')
    const a = clientAufrufe['status-se']!
    expect(a[0]!.url).toBe(adresse(w))
    expect(a[2]!.url).toBe(adresse(w))
    expect(aktionen(w)).toEqual(['login', 'logout'])
    expect(a[0]!.soapAction).toBe('"login"')
    expect(a[2]!.soapAction).toBe('"logout"')
  })

  it('Registrierkassen-Dienst: Adresse und die eine Operation rkdb', () => {
    const w = wsdl('regKasseService.wsdl')
    const a = clientAufrufe['status-se']!
    expect(a[1]!.url).toBe(adresse(w))
    expect(aktionen(w)).toEqual(['rkdb'])
    expect(a[1]!.soapAction).toBe('"rkdb"')
  })

  it('Binding ist document/literal (die Nachricht ist genau ein Element im Body)', () => {
    for (const d of ['sessionService.wsdl', 'regKasseService.wsdl']) {
      expect(wsdl(d)).toContain('style="document"')
      expect(wsdl(d)).toContain('use="literal"')
    }
    for (const a of Object.values(clientAufrufe).flat()) {
      expect(a.envelope).toContain('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">')
    }
  })

  it('Namespaces: Session und rkdb', () => {
    expect(clientAufrufe['status-se']![0]!.body).toContain(`xmlns:fon="${NS_SESSION}"`)
    expect(clientAufrufe['status-se']![1]!.body).toContain(`xmlns:rk="${NS_RKDB}"`)
  })
})

// ---------------------------------------------------------------------------
// 3) Was der Client heute sendet (BEKANNTE BEFUNDE → it.fails)
// ---------------------------------------------------------------------------

describe('Requests des Clients sind schema-gültig — BEKANNTE BEFUNDE F-1 … F-7, F-10', () => {
  const gueltig = (name: string) => () => {
    const e = urteil(name)
    expect(e.fehler, `XSD-Meldungen zu ${name}`).toEqual([])
  }

  it.fails('F-1  login: Wurzelelement muss loginRequest heißen (Client sendet login)', gueltig('client-status-se-0'))
  it.fails('F-2  logout: Wurzelelement muss logoutRequest heißen (Client sendet logout)', gueltig('client-status-se-2'))
  it.fails('F-3/F-4  Status SEE: Element status_see, Namespace, Pflichtfelder paket_nr/ts_erstellung/satznr', gueltig('client-status-se-1'))
  it.fails('F-3/F-4  Status Kasse: Namespace + Pflichtfelder paket_nr/ts_erstellung/satznr', gueltig('client-status-kasse-1'))
  it.fails('F-3/F-4/F-6  Registrierung: Namespace, Pflichtfelder, SE und Kasse in getrennten Aufrufen', gueltig('client-registrierung-1'))
  it.fails('F-7  Außerbetriebnahme: Datensatz ausfall_kasse mit ausserbetriebnahme/begruendung', gueltig('client-ausserbetriebnahme-1'))
  it.fails('F-7  SEE-Ausfall: ausfall mit begruendung + beginn_ausfall', gueltig('client-ausfall-se-1'))
  it.fails('F-7  SEE-Wiederinbetriebnahme: ende_ausfall statt ende', gueltig('client-wiederinbetriebnahme-se-1'))
  it.fails('F-10  Standard-Hersteller-ID erfüllt das Muster [0-9A-Za-z]{10,24} (enthält Unterstriche)', gueltig('soll-mit-standard-hersteller'))

  it('jeder Request ist wohlgeformtes XML mit genau einem Wurzelelement', () => {
    // Auch die fehlerhaften werden von libxml2 bis zur Schemaprüfung gelesen: Meldungen sind Schema-, keine Syntaxfehler.
    for (const [name, e] of pruefung) {
      if (!name.startsWith('client-')) continue
      expect(e.fehler.join('\n'), name).not.toMatch(/Extra content|parser error|Start tag expected/i)
    }
  })
})

// ---------------------------------------------------------------------------
// 4) Antworten: wie der Client schema-gültige Antworten auswertet
// ---------------------------------------------------------------------------

describe('Antworten des Dienstes im Client (rkdb.ts)', () => {
  const see = generateSEE({ kassenId: BSP_KASSE, uid: 'ATU12345678', firmenname: 'Antwort GmbH' })
  const registrierung = async (): Promise<KassenRegistrierung> => {
    const s = await see
    return {
      kassenId: BSP_KASSE, uid: 'ATU12345678', zertifikatDER: s.zertifikatDER, credentials: ZUGANG,
      benutzerschluesselBase64: s.aesSchluessel.toString('base64'), vdaId: 'AT1', artSe: 'HSM_DIENSTLEISTER',
    }
  }

  it('Kontrolle: Login-Fehler (rc -4) wird gemeldet', async () => {
    const { ergebnis } = await mitDienst([ANTWORTEN['login-fehler']!.xml], c => c.statusSe(BSP_SEE_SN, ZUGANG))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-4')
  })

  it('Kontrolle: ein Ergebnis mit rc 0 ist ein Erfolg', async () => {
    const { ergebnis } = await mitDienst(OK, async c => c.kasseInBetriebNehmen(await registrierung()))
    expect(ergebnis.erfolgreich).toBe(true)
  })

  it('Kontrolle: ein Ergebnis mit rc ≠ 0 ist ein Fehler', async () => {
    const abgelehnt = ANTWORTEN['rkdb-zweiter-datensatz-abgelehnt']!.xml.replace(/<rk:result><rk:satznr>1<\/rk:satznr>[\s\S]*?<\/rk:result>/, '')
    const { ergebnis } = await mitDienst(mitAntwort(abgelehnt), async c => c.kasseInBetriebNehmen(await registrierung()))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-42')
  })

  // F-9: Pro Datensatz (result) und pro Meldung (rkdbMessage) gibt es einen eigenen rc; der Client liest nur den ersten.
  it.fails('F-9  zwei Ergebnisse, das zweite abgelehnt → Registrierung gilt als gescheitert', async () => {
    const { ergebnis } = await mitDienst(mitAntwort(ANTWORTEN['rkdb-zweiter-datensatz-abgelehnt']!.xml),
      async c => c.kasseInBetriebNehmen(await registrierung()))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-42')
  })

  it.fails('F-9  mehrere Meldungen zu einem Datensatz, die zweite ein Fehler → gescheitert', async () => {
    const { ergebnis } = await mitDienst(mitAntwort(ANTWORTEN['rkdb-mehrere-meldungen']!.xml),
      async c => c.kasseInBetriebNehmen(await registrierung()))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-7')
  })

  // F-8: abfrage_ergebnis ist laut Schema ein Element MIT Kindern (ts_registrierung, status, ts_status), kein Text.
  it.fails('F-8  Kassen-Status REGISTRIERT aus abfrage_ergebnis/status wird erkannt', async () => {
    const { ergebnis } = await mitDienst(mitAntwort(ANTWORTEN['status-kasse-registriert']!.xml),
      c => c.startbelegPruefen({} as never, ZUGANG, BSP_KASSE))
    expect(ergebnis.fehler).toBeUndefined()
    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.pruefwert).toBe('REGISTRIERT')
  })

  it.fails('F-8  SEE-Status AKTIVIERT wird als Statuswert geliefert (nicht das ganze Element)', async () => {
    const { ergebnis } = await mitDienst(mitAntwort(ANTWORTEN['status-see-aktiviert']!.xml),
      c => c.statusSe(BSP_SEE_SN, ZUGANG))
    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.pruefwert).toBe('AKTIVIERT')
  })

  it('die Mock-Antworten der bestehenden Unit-Tests sind NICHT schema-gültig (verdecken die Befunde)', () => {
    // finanz-online.test.ts antwortet z. B. mit <result><rc>0</rc></result> und <abfrage_ergebnis>AKTIVIERT</…>.
    // Dokumentiert hier, damit niemand diese Mocks für Schema-Nachweise hält.
    expect(urteil('fehlerhaft-antwort-abfrage-ergebnis-als-text').gueltig).toBe(false)
  })
})
