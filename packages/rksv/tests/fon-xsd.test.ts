/**
 * EXTERNE GEGENPROBE: FinanzOnline-Client gegen die amtlichen Schemas des BMF.
 *
 * Die Unit-Tests in finanz-online.test.ts mocken `fetch` und prüfen das Verhalten des Clients — ob der Dienst die Nachricht
 * annehmen würde, sagen sie nicht. Hier werden die Requests, die der Client wirklich erzeugt, mit libxml2 gegen
 * session.xsd / regKasseWs.xsd geprüft (Schemas unverändert in fixtures/fon-xsd, Quelle und Prüfsummen dort).
 *
 * STAND: Der Client erzeugt schema-gültige Requests und wertet schema-gültige Antworten richtig aus. Die elf Befunde F-1 … F-11
 * der Prüfstrecke (PRUEFSTRECKE.md, Abschnitt C) waren hier als `it.fails` festgehalten; behoben sind F-1 … F-10 — die Tests
 * unten tragen die Nummern weiter, damit die Zuordnung erhalten bleibt. F-11 (die Software-Signatur AT0 ist als `registrierung_se`
 * nicht meldbar) ist KEIN Fehler des Clients, sondern eine Eigenschaft des Schemas: der Client sendet für AT0 nichts und meldet
 * das (Test „F-11"); wie AT0 stattdessen gemeldet wird, ist eine offene Entscheidung (FINANZONLINE-ABGLEICH.md).
 * Ein künftiger Rückfall fällt doppelt auf: die benannten Tests werden rot, und der Sammeltest prüft JEDE Nachricht, die der
 * Client in diesen Läufen sendet.
 *
 * Die Soll-Beispiele (fixtures/fon-beispiele.ts) zeigen, wie die Nachrichten aussehen müssen; sie werden hier selbst gegen die
 * Schemas geprüft, ebenso wie die Antworten, die finanz-online.test.ts als Mocks verwendet.
 *
 * Alle Details der Verstöße ausgeben:  FON_XSD_BEFUNDE=1 pnpm exec vitest run tests/fon-xsd.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zertSeriennummerDezimal } from '../src/finanz-online.js'
import { generateSEE } from '../src/see.js'
import type { FinanzOnlineCredentials, KassenRegistrierung } from '../src/types.js'
import { validiereGegenXsd, FON_XSD_ORDNER, type FonSchema, type XsdErgebnis, type XsdFall } from './helpers/xsd.js'
import { mitDienst, standardAntworter, type Antworter, type Aufruf } from './helpers/fon-dienst.js'
import {
  ANTWORTEN, SOLL_ANFRAGEN, NS_RKDB, NS_SESSION,
  BSP_AES_B64, BSP_BENID, BSP_HERSTELLER, BSP_KASSE, BSP_SEE_SN, BSP_SEE_SN_HEX, BSP_TID,
} from './fixtures/fon-beispiele.js'

/** Zugangsdaten, die für sich schema-gültig sind — Mängel sollen aus dem Client kommen, nicht aus Testdaten. */
const ZUGANG: FinanzOnlineCredentials = {
  teilnehmerId: BSP_TID, benutzerkennung: BSP_BENID, pin: 'geheim123', herstellerId: BSP_HERSTELLER,
}

const antwort = (name: string): string => ANTWORTEN[name]!.xml

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
  'login-statt-loginrequest': {
    schema: 'session',
    xml: SOLL_ANFRAGEN['login']!.xml.replace(/ses:loginRequest/g, 'ses:login'),
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
  'ausserbetriebnahme-als-eigener-datensatz': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['ausserbetriebnahme-kasse']!.xml.replace(/rk:ausfall_kasse>/g, 'rk:ausserbetriebnahme_kasse>'),
  },
  'begruendung-null': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['ausfall-se']!.xml.replace('<rk:begruendung>2</rk:begruendung>', '<rk:begruendung>0</rk:begruendung>'),
  },
  'ausfall-zeit-ohne-datum': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['ausfall-se']!.xml.replace('2026-11-02T07:30:00', '07:30'),
  },
  'seriennummer-mit-praefix': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-see-hex']!.xml.replace(`>${BSP_SEE_SN_HEX}<`, `>0x${BSP_SEE_SN_HEX}<`),
  },
  'hex-attribut-kein-boolean': {
    schema: 'rkdb',
    xml: SOLL_ANFRAGEN['status-see-hex']!.xml.replace('hex="true"', 'hex="ja"'),
  },
  'antwort-abfrage-ergebnis-als-text': {
    schema: 'rkdb',
    xml: ANTWORTEN['status-kasse-registriert']!.xml.replace(/<rk:abfrage_ergebnis>[\s\S]*<\/rk:abfrage_ergebnis>/, '<rk:abfrage_ergebnis>REGISTRIERT</rk:abfrage_ergebnis>'),
  },
}

/** Was der Client sendet — je Lauf die Anfragen in der Reihenfolge (Login, … , Logout). */
const clientAufrufe: Record<string, Aufruf[]> = {}

let reg: KassenRegistrierung

beforeAll(async () => {
  const see = await generateSEE({ kassenId: BSP_KASSE, uid: 'ATU12345678', firmenname: 'XSD GmbH' })
  reg = {
    kassenId: BSP_KASSE, uid: 'ATU12345678', zertifikatDER: see.zertifikatDER, credentials: ZUGANG,
    benutzerschluesselBase64: see.aesSchluessel.toString('base64'), vdaId: 'AT1', artSe: 'HSM_DIENSTLEISTER',
  }

  /** FinanzOnline kennt die SE noch nicht: Statusabfrage schlägt fehl, dann folgen SE und Kasse. */
  const seUnbekannt: Antworter = standardAntworter({ status_see: antwort('status-see-unbekannt') })
  /** … und kennt sie schon: nur die Kasse wird gemeldet. */
  const seBekannt: Antworter = standardAntworter({ status_see: antwort('status-see-aktiviert') })

  const laeufe: Record<string, { antworter?: Antworter; aktion: Parameters<typeof mitDienst>[1] }> = {
    'status-se':               { aktion: c => c.statusSe(BSP_SEE_SN_HEX, ZUGANG) },
    'registrierung':           { antworter: seUnbekannt, aktion: c => c.kasseInBetriebNehmen(reg) },
    'registrierung-se-bekannt': { antworter: seBekannt,  aktion: c => c.kasseInBetriebNehmen(reg) },
    'status-kasse':            { aktion: c => c.startbelegPruefen({} as never, ZUGANG, BSP_KASSE) },
    'ausserbetriebnahme':      { aktion: c => c.kasseAusserBetriebNehmen(BSP_KASSE, ZUGANG) },
    'ausserbetriebnahme-irreparabel': { aktion: c => c.kasseAusserBetriebNehmen(BSP_KASSE, ZUGANG, { begruendung: 7 }) },
    'ausfall-se':              { aktion: c => c.seeAusfallMelden(BSP_KASSE, BSP_SEE_SN_HEX, ZUGANG) },
    // Beginn mit Sommer- und Winterzeit, anderer Begründungscode, lange SEE-Seriennummer (bis 50 Hex-Zeichen)
    'ausfall-se-sommer':       { aktion: c => c.seeAusfallMelden(BSP_KASSE, BSP_SEE_SN_HEX, ZUGANG, { beginn: new Date('2026-07-01T08:00:00Z'), begruendung: 99 }) },
    'ausfall-se-winter':       { aktion: c => c.seeAusfallMelden(BSP_KASSE, 'A'.repeat(40), ZUGANG, { beginn: new Date('2026-01-15T08:00:00Z'), begruendung: 1 }) },
    'wiederinbetriebnahme-se': { aktion: c => c.seeWiederinbetriebnahmeMelden(BSP_KASSE, BSP_SEE_SN_HEX, ZUGANG) },
    'wiederinbetriebnahme-se-zeit': { aktion: c => c.seeWiederinbetriebnahmeMelden(BSP_KASSE, BSP_SEE_SN_HEX, ZUGANG, { ende: new Date('2026-03-29T01:30:00Z') }) },
    // Sonderzeichen in Werten, die der Client maskieren muss
    'status-kasse-sonderzeichen': { aktion: c => c.startbelegPruefen({} as never, { ...ZUGANG, pin: `p<&>"'in1` }, `K&<>"'1`) },
  }
  for (const [name, { antworter, aktion }] of Object.entries(laeufe)) {
    const { aufrufe } = await mitDienst(antworter ?? standardAntworter(), aktion)
    clientAufrufe[name] = aufrufe
    aufrufe.forEach((a, i) => faelle.push({ name: `client-${name}-${i}`, schema: a.schema, xml: a.body }))
  }
  // Standard-Hersteller-ID: Login ohne eigene herstellerId (Platzhalter des Clients)
  const { aufrufe: ohneHersteller } = await mitDienst(standardAntworter(), c =>
    c.statusSe(BSP_SEE_SN_HEX, { teilnehmerId: BSP_TID, benutzerkennung: BSP_BENID, pin: 'geheim123' }))
  clientAufrufe['standard-hersteller'] = ohneHersteller
  ohneHersteller.forEach((a, i) => faelle.push({ name: `client-standard-hersteller-${i}`, schema: a.schema, xml: a.body }))

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
  const standardHersteller = /<ses:herstellerid>([^<]*)<\/ses:herstellerid>/.exec(clientAufrufe['standard-hersteller']![0]!.body)![1]!
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
  // Mehrere davon sind genau die Fehler, die der Client früher machte (F-1, F-3, F-5, F-7, F-10).
  const gegenproben: [string, RegExp][] = [
    ['hersteller-mit-unterstrich',        /herstellerid.*(pattern|not accepted)/i],
    ['login-statt-loginrequest',          /login.*(No matching global declaration|not expected)/i],
    ['rkdb-ohne-paketnummer',             /paket_nr|not expected|Missing child/i],
    ['rkdb-element-ohne-namespace',       /not expected/i],
    ['rkdb-se-und-kasse-gemeinsam',       /registrierung_kasse.*not expected/i],
    ['vda-id-at0',                        /vda_id.*(pattern|not accepted)/i],
    ['benutzerschluessel-zu-kurz',        /benutzerschluessel.*(length|pattern|not accepted)/i],
    ['art-uebermittlung-klein',           /art_uebermittlung.*(enumeration|not accepted|valid)/i],
    ['status-se-statt-status-see',        /status_se.*not expected/i],
    ['ausserbetriebnahme-als-eigener-datensatz', /ausserbetriebnahme_kasse.*not expected/i],
    ['begruendung-null',                  /begruendung.*(minInclusive|not accepted|valid)/i],
    ['ausfall-zeit-ohne-datum',           /beginn_ausfall.*(dateTime|not accepted|valid)/i],
    ['seriennummer-mit-praefix',          /zertifikatsseriennummer.*(pattern|not accepted|valid)/i],
    ['hex-attribut-kein-boolean',         /hex.*(boolean|not accepted|valid)/i],
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

describe('Vertragsdetails aus dem Schema (Befund F-11: Software-SEE nicht als SE meldbar)', () => {
  // F-11: Die Software-SEE der Kassa trägt die ZDA-Kennung AT0. Das Schema lässt für `registrierung_se` nur
  // vda_id [A-Z]{2}[1-9][0-9]? zu — AT0 ist ausgeschlossen (die BMF-Beschreibung nennt AT1 A-Trust, AT2 GlobalTrust, AT3 PrimeSign).
  // Eine Software-SEE wird laut Schema als geschlossenes Gesamtsystem gemeldet (registrierung_ggs, art_se_ggs SW_GGS).
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

  it('F-11  der Client sendet für AT0 nichts und sagt, warum (kein ungültiger Request an FinanzOnline)', async () => {
    const { aufrufe, ergebnis } = await mitDienst(standardAntworter(), c =>
      c.kasseInBetriebNehmen({ ...reg, vdaId: 'AT0', artSe: 'EIGENES_HSM' }))
    expect(aufrufe, 'es darf nicht einmal ein Login stattfinden').toEqual([])
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toMatch(/AT0/)
    expect(ergebnis.fehler).toMatch(/A-Trust/)
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
    expect(clientAufrufe['status-se']![0]!.body).toContain(`xmlns:ses="${NS_SESSION}"`)
    expect(clientAufrufe['status-se']![1]!.body).toContain(`xmlns:rk="${NS_RKDB}"`)
  })
})

// ---------------------------------------------------------------------------
// 3) Was der Client sendet (Befunde F-1 … F-7, F-10 behoben)
// ---------------------------------------------------------------------------

describe('Requests des Clients sind schema-gültig — Befunde F-1 … F-7, F-10', () => {
  const gueltig = (name: string) => () => {
    const e = urteil(name)
    expect(e.fehler, `XSD-Meldungen zu ${name}`).toEqual([])
  }

  it('F-1  login: Wurzelelement loginRequest', gueltig('client-status-se-0'))
  it('F-2  logout: Wurzelelement logoutRequest', gueltig('client-status-se-2'))
  it('F-3/F-4/F-5  Status SEE: Element status_see, Namespace, Pflichtfelder paket_nr/ts_erstellung/satznr', gueltig('client-status-se-1'))
  it('F-3/F-4  Status Kasse: Namespace + Pflichtfelder paket_nr/ts_erstellung/satznr', gueltig('client-status-kasse-1'))

  it('F-3/F-4/F-6  Registrierung: Statusabfrage der SE, registrierung_se und registrierung_kasse in getrennten Aufrufen', () => {
    const a = clientAufrufe['registrierung']!
    expect(a.map(x => x.art)).toEqual(['login', 'status_see', 'rkdb', 'rkdb', 'logout'])
    for (let i = 0; i < a.length; i++) gueltig(`client-registrierung-${i}`)()
    // genau EINE Datensatzart je rkdb (xs:choice)
    expect(a[2]!.body).toContain('<rk:registrierung_se>')
    expect(a[2]!.body).not.toContain('registrierung_kasse')
    expect(a[3]!.body).toContain('<rk:registrierung_kasse>')
    expect(a[3]!.body).not.toContain('registrierung_se')
  })

  it('F-6  kennt FinanzOnline die SE schon, wird nur die Kasse gemeldet', () => {
    const a = clientAufrufe['registrierung-se-bekannt']!
    expect(a.map(x => x.art)).toEqual(['login', 'status_see', 'rkdb', 'logout'])
    expect(a[2]!.body).toContain('<rk:registrierung_kasse>')
    for (let i = 0; i < a.length; i++) gueltig(`client-registrierung-se-bekannt-${i}`)()
  })

  it('F-7  Außerbetriebnahme: Datensatz ausfall_kasse mit ausserbetriebnahme/begruendung', () => {
    gueltig('client-ausserbetriebnahme-1')()
    gueltig('client-ausserbetriebnahme-irreparabel-1')()
    const body = clientAufrufe['ausserbetriebnahme']![1]!.body
    expect(body).toContain('<rk:ausfall_kasse>')
    expect(body).not.toContain('ausserbetriebnahme_kasse')
    expect(body).toContain('<rk:ausserbetriebnahme><rk:begruendung>6</rk:begruendung></rk:ausserbetriebnahme>')
  })

  it('F-7  SEE-Ausfall: ausfall mit begruendung + beginn_ausfall', () => {
    gueltig('client-ausfall-se-1')()
    gueltig('client-ausfall-se-sommer-1')()
    gueltig('client-ausfall-se-winter-1')()
    const body = clientAufrufe['ausfall-se']![1]!.body
    expect(body).toContain('<rk:ausfall><rk:begruendung>2</rk:begruendung><rk:beginn_ausfall>')
  })

  it('F-7  SEE-Wiederinbetriebnahme: ende_ausfall statt ende', () => {
    gueltig('client-wiederinbetriebnahme-se-1')()
    gueltig('client-wiederinbetriebnahme-se-zeit-1')()
    expect(clientAufrufe['wiederinbetriebnahme-se']![1]!.body).toContain('<rk:ende_ausfall>')
  })

  it('Seriennummern der SEE gehen hexadezimal mit hex="true" hinaus (die Datenbank hält sie hexadezimal)', () => {
    for (const lauf of ['status-se', 'ausfall-se', 'wiederinbetriebnahme-se']) {
      const body = clientAufrufe[lauf]![1]!.body
      expect(body, lauf).toContain(`<rk:zertifikatsseriennummer hex="true">${BSP_SEE_SN_HEX}</rk:zertifikatsseriennummer>`)
    }
  })

  it('Sonderzeichen in Kassen-ID und PIN werden maskiert — die Nachricht bleibt schema-gültig', () => {
    gueltig('client-status-kasse-sonderzeichen-0')()
    gueltig('client-status-kasse-sonderzeichen-1')()
    expect(clientAufrufe['status-kasse-sonderzeichen']![1]!.body).toContain('K&amp;&lt;&gt;&quot;&apos;1')
  })

  it('F-10  Standard-Hersteller-ID erfüllt das Muster [0-9A-Za-z]{10,24}', () => {
    gueltig('soll-mit-standard-hersteller')()
    gueltig('client-standard-hersteller-0')()
  })

  it('Sammeltest: JEDE Nachricht, die der Client in diesen Läufen sendet, ist schema-gültig', () => {
    const clientFaelle = faelle.filter(f => f.name.startsWith('client-'))
    expect(clientFaelle.length).toBeGreaterThanOrEqual(40)
    for (const f of clientFaelle) expect(urteil(f.name).fehler, f.name).toEqual([])
  })

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

describe('Antworten des Dienstes im Client (rkdb.ts) — Befunde F-8, F-9 behoben', () => {
  /** SE ist bekannt (Statusabfrage ok) — die Antwort unter Test gehört dann zur Registrierung der KASSE. */
  const zurKasse = (rkdb: string): Antworter =>
    standardAntworter({ status_see: antwort('status-see-aktiviert'), rkdb })

  it('Kontrolle: Login-Fehler (rc -4) wird gemeldet', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ login: antwort('login-fehler') }), c => c.statusSe(BSP_SEE_SN_HEX, ZUGANG))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-4')
  })

  it('Kontrolle: ein Ergebnis mit rc 0 ist ein Erfolg', async () => {
    const { ergebnis } = await mitDienst(zurKasse(antwort('rkdb-ok')), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(true)
  })

  it('Kontrolle: ein Ergebnis mit rc ≠ 0 ist ein Fehler', async () => {
    const abgelehnt = antwort('rkdb-zweiter-datensatz-abgelehnt').replace(/<rk:result><rk:satznr>1<\/rk:satznr>[\s\S]*?<\/rk:result>/, '')
    const { ergebnis } = await mitDienst(zurKasse(abgelehnt), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-42')
  })

  // F-9: Pro Datensatz (result) und pro Meldung (rkdbMessage) gibt es einen eigenen rc; der Client las nur den ersten.
  it('F-9  zwei Ergebnisse, das zweite abgelehnt → Registrierung gilt als gescheitert', async () => {
    const { ergebnis } = await mitDienst(zurKasse(antwort('rkdb-zweiter-datensatz-abgelehnt')), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-42')
    expect(ergebnis.fehler).toContain('Kasse bereits registriert')
  })

  it('F-9  mehrere Meldungen zu einem Datensatz, die zweite ein Fehler → gescheitert', async () => {
    const { ergebnis } = await mitDienst(zurKasse(antwort('rkdb-mehrere-meldungen')), c => c.kasseInBetriebNehmen(reg))
    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('-7')
    expect(ergebnis.fehler).toContain('Zertifikat unbekannt')
    // die erste Meldung (rc 0, „Hinweis") ist keine Fehlermeldung und kommt im Fehlertext nicht vor
    expect(ergebnis.fehler).not.toContain('Hinweis')
  })

  // F-8: abfrage_ergebnis ist laut Schema ein Element MIT Kindern (ts_registrierung, status, ts_status), kein Text.
  it('F-8  Kassen-Status REGISTRIERT aus abfrage_ergebnis/status wird erkannt', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_kasse: antwort('status-kasse-registriert') }),
      c => c.startbelegPruefen({} as never, ZUGANG, BSP_KASSE))
    expect(ergebnis.fehler).toBeUndefined()
    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.pruefwert).toBe('REGISTRIERT')
  })

  it('F-8  SEE-Status AKTIVIERT wird als Statuswert geliefert (nicht das ganze Element)', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_see: antwort('status-see-aktiviert') }),
      c => c.statusSe(BSP_SEE_SN_HEX, ZUGANG))
    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.pruefwert).toBe('AKTIVIERT')
  })

  it('F-8  die Statusantwort mit Standard-Namespace (Kinder mit xmlns="") wird ebenso gelesen', async () => {
    const { ergebnis } = await mitDienst(standardAntworter({ status_kasse: antwort('status-kasse-standardnamespace') }),
      c => c.startbelegPruefen({} as never, ZUGANG, BSP_KASSE))
    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.pruefwert).toBe('IN_BETRIEB')
  })
})
