/**
 * HAERTETEST – BIT-64
 *
 * Systemischer Belastungstest (BMF-Detailspezifikation):
 *   1. Verkettung unter Last (100+ Belege in schneller Folge)
 *   2. AES-ICM Verschlüsselung mit Grenzwerten (eigener Schlüssel, Spec-IV)
 *   3. Alle Belegtypen validiert
 *   4. DEP7-Format (Belege-Gruppe / Belege-kompakt) vollständig geprüft
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { generateSEE } from '../src/see.js'
import { RKSVKasse } from '../src/index.js'
import {
  signiereBeleg,
  erstelleStartbeleg,
} from '../src/beleg.js'
import { pruefeKette, verkettungswertStartbeleg, verkettungswertFolgebeleg } from '../src/crypto/chain.js'
import {
  generiereAesSchluessel,
  berechneIV,
  verschluesselUmsatzzaehler,
  entschluesselUmsatzzaehler,
} from '../src/crypto/aes-icm.js'
import { erstelleDEP7Export, validiereDEP7, dep7ZuJson, dep7AusJson } from '../src/dep.js'
import type { RawBeleg, SEEConfig, SignedBeleg, BelegTyp } from '../src/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const KASSE = 'HAERTE-KASSE-001'
let see: SEEConfig

beforeAll(async () => {
  see = await generateSEE({
    kassenId:   KASSE,
    uid:        'ATU99887766',
    firmenname: 'Haertetest GmbH',
  })
})

// ---------------------------------------------------------------------------
// 1. Verkettung unter Last
// ---------------------------------------------------------------------------

describe('Verkettung unter Last', () => {
  it('100 Belege in schneller Folge – Kette vollständig valide', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    const t0 = Date.now()

    for (let i = 2; i <= 101; i++) {
      const raw: RawBeleg = {
        kassenId:     KASSE,
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: `Artikel-${i}`, menge: 1, einzelpreisBreutto: i * 10, mwstSatz: 'normal' },
        ],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    const dauer = Date.now() - t0
    console.log(`100 Belege signiert in ${dauer}ms`)

    expect(belege).toHaveLength(101)
    expect(pruefeKette(KASSE, belege)).toBe(true)
  })

  it('Kettenintegrität: jeder Beleg referenziert den korrekten Vorgänger', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 20; i++) {
      const raw: RawBeleg = {
        kassenId:     KASSE,
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
        ],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    // Manuell jeden Verkettungswert gegen den berechneten Wert prüfen
    expect(belege[0]?.sigVorbeleg).toBe(verkettungswertStartbeleg(KASSE))

    for (let i = 1; i < belege.length; i++) {
      const erwartet = verkettungswertFolgebeleg(belege[i - 1]!.maschinenlesbareCode)
      expect(belege[i]?.sigVorbeleg).toBe(erwartet)
    }
  })

  it('Manipulation eines mittleren Beleg-Codes bricht die Kette', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 10; i++) {
      const beleg = signiereBeleg({
        kassenId:     KASSE,
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    expect(pruefeKette(KASSE, belege)).toBe(true)

    // Beleg 5 (Index 4) manipulieren — der Folgebeleg referenziert den Original-Code
    const manipuliert = [...belege]
    manipuliert[4] = { ...belege[4]!, maschinenlesbareCode: belege[4]!.maschinenlesbareCode + 'X' }
    expect(pruefeKette(KASSE, manipuliert)).toBe(false)
  })

  it('Wiederhergestellte Kasse setzt Kette korrekt fort', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 5; i++) {
      const beleg = signiereBeleg({
        kassenId:     KASSE,
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    // "Neustart": Kasse aus persistiertem Zustand wiederherstellen
    const wiederhergestellt = RKSVKasse.wiederherstellen(
      see,
      kontext.umsatzzaehler.aktuell,
      kontext.letzterBelegCode!,
    )

    const naechsterBeleg = wiederhergestellt.signiereBeleg({
      kassenId:     KASSE,
      belegNummer:  6,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'NachNeustart', menge: 1, einzelpreisBreutto: 200, mwstSatz: 'normal' }],
    })
    belege.push(naechsterBeleg)

    expect(pruefeKette(KASSE, belege)).toBe(true)
  })

  it('500 Belege Kettentest – keine Performance-Regression', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    const t0 = Date.now()

    for (let i = 2; i <= 501; i++) {
      const beleg = signiereBeleg({
        kassenId:     KASSE,
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    const dauer = Date.now() - t0
    console.log(`500 Belege signiert in ${dauer}ms (${(dauer / 500).toFixed(2)}ms/Beleg)`)

    expect(pruefeKette(KASSE, belege)).toBe(true)
    expect(dauer).toBeLessThan(10_000) // 10s Grenzwert für 500 Belege
  })
})

// ---------------------------------------------------------------------------
// 2. AES-ICM Verschlüsselung – Grenzwerte
// ---------------------------------------------------------------------------

describe('AES-ICM Grenzwerte', () => {
  const key      = generiereAesSchluessel()
  const kassenId = KASSE

  it('Nullwert (leerer Umsatz)', () => {
    const enc = verschluesselUmsatzzaehler(0n, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 1)).toBe(0n)
  })

  it('Negativer Wert (Storno, -99999 Cent)', () => {
    const enc = verschluesselUmsatzzaehler(-99999n, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 1)).toBe(-99999n)
  })

  it('Sehr großer positiver Wert (Int64-Max = 9223372036854775807)', () => {
    const max = 9223372036854775807n  // 2^63 - 1
    const enc = verschluesselUmsatzzaehler(max, key, kassenId, 99)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 99)).toBe(max)
  })

  it('Negativer Extremwert (Int64-Min = -9223372036854775808)', () => {
    const min = -9223372036854775808n  // -(2^63)
    const enc = verschluesselUmsatzzaehler(min, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 1)).toBe(min)
  })

  it('Einzelner Cent (1)', () => {
    const enc = verschluesselUmsatzzaehler(1n, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 1)).toBe(1n)
  })

  it('Falscher Schlüssel liefert falsches Ergebnis', () => {
    const original = 1000n
    const enc = verschluesselUmsatzzaehler(original, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, generiereAesSchluessel(), kassenId, 1)).not.toBe(original)
  })

  it('Falsche Kassen-ID liefert falsches Ergebnis (IV-Abhängigkeit)', () => {
    const original = 1000n
    const enc = verschluesselUmsatzzaehler(original, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, 'ANDERE-KASSE', 1)).not.toBe(original)
  })

  it('Falsche Belegnummer liefert falsches Ergebnis', () => {
    const original = 50000n
    const enc = verschluesselUmsatzzaehler(original, key, kassenId, 1)
    expect(entschluesselUmsatzzaehler(enc, key, kassenId, 2)).not.toBe(original)
  })

  it('Verschlüsselung ist 8 Bytes für alle Grenzwerte', () => {
    const werte = [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n, 999999999999n]
    for (const wert of werte) {
      const enc = verschluesselUmsatzzaehler(wert, key, kassenId, 1)
      expect(enc).toHaveLength(8)
    }
  })

  it('IV: Spec-Konstruktion, 16 Byte, große Belegnummer (2^32 - 1)', () => {
    const iv = berechneIV(kassenId, 0xFFFFFFFF)
    expect(iv).toHaveLength(16)
    expect(iv.equals(berechneIV(kassenId, 0xFFFFFFFF))).toBe(true)  // deterministisch
    expect(iv.equals(berechneIV(kassenId, 0xFFFFFFFE))).toBe(false)
  })

  it('Umsatzzähler-Roundtrip mit dem SEE-eigenen Schlüssel', async () => {
    const testSee = await generateSEE({
      kassenId:   'AES-TEST-KASSE',
      uid:        'ATU11223344',
      firmenname: 'AES Test GmbH',
    })
    const wert = 123456789n
    const enc = verschluesselUmsatzzaehler(wert, testSee.aesSchluessel, testSee.kassenId, 42)
    const dec = entschluesselUmsatzzaehler(enc, testSee.aesSchluessel, testSee.kassenId, 42)
    expect(dec).toBe(wert)
  })
})

// ---------------------------------------------------------------------------
// 3. Alle Belegtypen
// ---------------------------------------------------------------------------

describe('Alle Belegtypen', () => {
  const belegTypen: BelegTyp[] = [
    'Barzahlungsbeleg',
    'Startbeleg',
    'Schlussbeleg',
    'Monatsbeleg',
    'Jahresbeleg',
    'Nullbeleg',
    'Stornobeleg',
    'Trainingsbeleg',
  ]

  it('jeder Belegtyp erzeugt einen gültigen maschinenlesbaren Code', () => {
    const { kontext } = erstelleStartbeleg(KASSE, see)

    for (let i = 0; i < belegTypen.length; i++) {
      const typ = belegTypen[i]!
      const raw: RawBeleg = {
        kassenId:     KASSE,
        belegNummer:  i + 2,
        datumUhrzeit: new Date('2026-01-15T10:00:00'),
        belegTyp:     typ,
        positionen:   typ === 'Barzahlungsbeleg' || typ === 'Stornobeleg'
          ? [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }]
          : [],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode

      expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT0_/)
      expect(beleg.signaturwert).toBeTruthy()
      expect(beleg.belegTyp).toBe(typ)
    }
  })

  it('Startbeleg: Umsatzzähler bleibt 0', () => {
    const { beleg, kontext } = erstelleStartbeleg(KASSE, see)
    expect(kontext.umsatzzaehler.aktuell).toBe(0n)
    expect(beleg.belegTyp).toBe('Startbeleg')
  })

  it('Barzahlungsbeleg: Umsatzzähler steigt', () => {
    const { kontext } = erstelleStartbeleg(KASSE, see)
    signiereBeleg({
      kassenId: KASSE, belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'X', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(1000n)
  })

  it('Stornobeleg: Umsatzzähler sinkt (negativer Betrag)', () => {
    const { kontext } = erstelleStartbeleg(KASSE, see)
    // Erst Barzahlung
    signiereBeleg({
      kassenId: KASSE, belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Kaffee', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    }, kontext)

    const vorStorno = kontext.umsatzzaehler.aktuell
    // Dann Storno (negative Menge → negativer Betrag)
    signiereBeleg({
      kassenId: KASSE, belegNummer: 3,
      datumUhrzeit: new Date(), belegTyp: 'Stornobeleg',
      positionen: [{ bezeichnung: 'Kaffee (Storno)', menge: -1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    }, kontext)

    expect(kontext.umsatzzaehler.aktuell).toBe(vorStorno - 350n)
  })

  it.each(['Monatsbeleg', 'Jahresbeleg', 'Trainingsbeleg', 'Schlussbeleg'] as BelegTyp[])(
    '%s: ändert Umsatzzähler NICHT',
    (typ) => {
      const { kontext } = erstelleStartbeleg(KASSE, see)
      const vorher = kontext.umsatzzaehler.aktuell
      signiereBeleg({
        kassenId: KASSE, belegNummer: 2,
        datumUhrzeit: new Date(), belegTyp: typ,
        positionen: typ === 'Trainingsbeleg'
          ? [{ bezeichnung: 'Schulung', menge: 1, einzelpreisBreutto: 5000, mwstSatz: 'normal' }]
          : [],
      }, kontext)
      expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
    },
  )

  it('QR-Code-Format: alle 13 Felder vorhanden (Barzahlungsbeleg)', () => {
    const { kontext } = erstelleStartbeleg(KASSE, see)
    const beleg = signiereBeleg({
      kassenId: KASSE, belegNummer: 2,
      datumUhrzeit: new Date('2026-06-16T09:00:00'), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
    }, kontext)

    // _R1-AT0_{KID}_{BNR}_{BDT}_{BS-N}_{BS-E1}_{BS-E2}_{BS-0}_{BS-B}_{BSAU}_{ZKSN}_{BSKBV}_{SIG}
    const teile = beleg.maschinenlesbareCode.split('_')
    // Hinweis: das erste Element ist leer weil der Code mit '_' beginnt
    expect(teile.length).toBeGreaterThanOrEqual(13)
    expect(beleg.maschinenlesbareCode).toContain('R1-AT0')
    expect(beleg.maschinenlesbareCode).toContain(KASSE)
    expect(beleg.maschinenlesbareCode).toContain('2026-06-16T09:00:00')
    expect(beleg.maschinenlesbareCode).toContain('10,00')
  })
})

// ---------------------------------------------------------------------------
// 4. DEP7-Format (Belege-Gruppe / Belege-kompakt)
// ---------------------------------------------------------------------------

describe('DEP7-Format', () => {
  it('valider Export mit 50 Belegen – alle validiert', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 51; i++) {
      const beleg = signiereBeleg({
        kassenId: KASSE, belegNummer: i,
        datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Pos', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    const dep = erstelleDEP7Export(belege, see)
    const result = validiereDEP7(dep)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(51)
    expect(result.fehler).toHaveLength(0)
  })

  it('DEP7-JSON: Serialisierung und Deserialisierung erhält alle Daten', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const beleg2 = signiereBeleg({
      kassenId: KASSE, belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' }],
    }, kontext)

    const dep     = erstelleDEP7Export([start, beleg2], see)
    const json    = dep7ZuJson(dep)
    const parsed  = dep7AusJson(json)
    const result  = validiereDEP7(parsed)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(2)
    expect(parsed['Belege-Gruppe']).toHaveLength(1)
    expect(parsed['Belege-Gruppe'][0]?.['Belege-kompakt']).toHaveLength(2)
  })

  it('DEP7: jede Gruppe enthält Signaturzertifikat', () => {
    const { beleg: start } = erstelleStartbeleg(KASSE, see)
    const dep = erstelleDEP7Export([start], see)

    for (const pkg of dep['Belege-Gruppe']) {
      expect(pkg.Signaturzertifikat).toBeTruthy()
      expect(pkg.Signaturzertifikat.length).toBeGreaterThan(0)
    }
  })

  it('DEP7: alle Einträge sind RKSV-JWS (Payload beginnt mit _R1-)', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const beleg2 = signiereBeleg({
      kassenId: KASSE, belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Monatsbeleg',
      positionen: [],
    }, kontext)

    const dep = erstelleDEP7Export([start, beleg2], see)

    for (const pkg of dep['Belege-Gruppe']) {
      for (const jws of pkg['Belege-kompakt']) {
        const teile = jws.split('.')
        expect(teile).toHaveLength(3)
        expect(Buffer.from(teile[1]!, 'base64url').toString('utf8')).toMatch(/^_R1-AT0_/)
      }
    }
  })

  it('DEP7: ungültiger Eintrag wird als Fehler gemeldet', () => {
    const dep = {
      'Belege-Gruppe': [{
        Signaturzertifikat: 'CERT',
        Zertifizierungsstellen: [],
        'Belege-kompakt': ['KEIN_GUELTIGER_JWS'],
      }],
    }
    const result = validiereDEP7(dep)
    expect(result.gueltig).toBe(false)
    expect(result.fehler.length).toBeGreaterThan(0)
  })

  it('DEP7: Verkettung der Belege bleibt nach DEP7-Roundtrip rekonstruierbar', () => {
    const { beleg: start, kontext } = erstelleStartbeleg(KASSE, see)
    const alleSignedBelege: SignedBeleg[] = [start]

    for (let i = 2; i <= 5; i++) {
      const beleg = signiereBeleg({
        kassenId: KASSE, belegNummer: i,
        datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'X', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      alleSignedBelege.push(beleg)
    }

    // Originalkette ist valide
    expect(pruefeKette(KASSE, alleSignedBelege)).toBe(true)

    // DEP7-Export, Roundtrip und Kette AUS DEM DEP rekonstruieren
    const dep    = dep7AusJson(dep7ZuJson(erstelleDEP7Export(alleSignedBelege, see)))
    expect(validiereDEP7(dep).anzahlBelege).toBe(5)

    const ausDep = dep['Belege-Gruppe'][0]!['Belege-kompakt'].map(jws => {
      const payload = Buffer.from(jws.split('.')[1]!, 'base64url').toString('utf8')
      const sigB64  = Buffer.from(jws.split('.')[2]!, 'base64url').toString('base64')
      const code    = `${payload}_${sigB64}`
      const felder  = payload.split('_')
      return { maschinenlesbareCode: code, sigVorbeleg: felder[felder.length - 1]! }
    })
    expect(pruefeKette(KASSE, ausDep)).toBe(true)
  })
})
