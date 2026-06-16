/**
 * HAERTETEST – BIT-64
 *
 * Systemischer Belastungstest:
 *   1. Signaturkette unter Last (100+ Belege in schneller Folge)
 *   2. AES-ICM Verschlüsselung mit Grenzwerten
 *   3. Alle Belegtypen validiert
 *   4. DEP7-Format vollständig geprüft
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { generateSEE } from '../src/see.js'
import { RKSVKasse } from '../src/index.js'
import {
  signiereBeleg,
  erstelleStartbeleg,
  erstelleNullbeleg,
  berechneBetraege,
  Umsatzzaehler,
  type SignierungsKontext,
} from '../src/beleg.js'
import { pruefeKette, startbelegVorSignatur, folgebelegVorSignatur } from '../src/crypto/chain.js'
import {
  deriveAesKey,
  belegNummerZuIV,
  verschluesselUmsatzzaehler,
  entschluesselUmsatzzaehler,
} from '../src/crypto/aes-icm.js'
import { erstelleDEP7Export, validiereDEP7, dep7ZuJson, dep7AusJson } from '../src/dep.js'
import type { RawBeleg, SEEConfig, SignedBeleg, BelegTyp } from '../src/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let see: SEEConfig

beforeAll(async () => {
  see = await generateSEE({
    kassenId:   'HAERTE-KASSE-001',
    uid:        'ATU99887766',
    firmenname: 'Haertetest GmbH',
  })
})

// ---------------------------------------------------------------------------
// 1. Signaturkette unter Last
// ---------------------------------------------------------------------------

describe('Signaturkette unter Last', () => {
  it('100 Belege in schneller Folge – Kette vollständig valide', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    const t0 = Date.now()

    for (let i = 2; i <= 101; i++) {
      const raw: RawBeleg = {
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: `Artikel-${i}`, menge: 1, einzelpreisBreutto: i * 10, mwstSatz: 'normal' },
        ],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    const dauer = Date.now() - t0
    console.log(`100 Belege signiert in ${dauer}ms`)

    expect(belege).toHaveLength(101)
    expect(pruefeKette(belege)).toBe(true)
  })

  it('Kettenintegrität: jeder Beleg referenziert den korrekten Vorgänger', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 20; i++) {
      const raw: RawBeleg = {
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
        ],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    // Manuell jeden SigVorbeleg gegen den berechneten Wert prüfen
    const ersterSigVor = startbelegVorSignatur()
    expect(belege[0]?.sigVorbeleg).toBe(ersterSigVor)

    for (let i = 1; i < belege.length; i++) {
      const erwartet = folgebelegVorSignatur(belege[i - 1]!.signaturwert)
      expect(belege[i]?.sigVorbeleg).toBe(erwartet)
    }
  })

  it('Manipulation eines mittleren Signaturwerts bricht die Kette', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 10; i++) {
      const beleg = signiereBeleg({
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    expect(pruefeKette(belege)).toBe(true)

    // Beleg 5 (Index 4) manipulieren
    const manipuliert = [...belege]
    manipuliert[4] = { ...belege[4]!, signaturwert: 'MANIPULIERTER_WERT_XYZ' }
    expect(pruefeKette(manipuliert)).toBe(false)
  })

  it('Wiederhergestellte Kasse setzt Kette korrekt fort', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 5; i++) {
      const beleg = signiereBeleg({
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    // "Neustart": Kasse aus persistiertem Zustand wiederherstellen
    const wiederhergestellt = RKSVKasse.wiederherstellen(
      see,
      kontext.umsatzzaehler.aktuell,
      kontext.letzterSignaturwert!,
    )

    const naechsterBeleg = wiederhergestellt.signiereBeleg({
      kassenId:     'HAERTE-KASSE-001',
      belegNummer:  6,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'NachNeustart', menge: 1, einzelpreisBreutto: 200, mwstSatz: 'normal' }],
    })
    belege.push(naechsterBeleg)

    expect(pruefeKette(belege)).toBe(true)
  })

  it('500 Belege Kettentest – keine Performance-Regression', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    const t0 = Date.now()

    for (let i = 2; i <= 501; i++) {
      const beleg = signiereBeleg({
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    const dauer = Date.now() - t0
    console.log(`500 Belege signiert in ${dauer}ms (${(dauer / 500).toFixed(2)}ms/Beleg)`)

    expect(pruefeKette(belege)).toBe(true)
    expect(dauer).toBeLessThan(10_000) // 10s Grenzwert für 500 Belege
  })
})

// ---------------------------------------------------------------------------
// 2. AES-ICM Verschlüsselung – Grenzwerte
// ---------------------------------------------------------------------------

describe('AES-ICM Grenzwerte', () => {
  const cert     = Buffer.from('HAERTE-TEST-ZERTIFIKAT-DER-DATEN', 'utf8')
  const kassenId = 'HAERTE-KASSE-001'

  it('Nullwert (leerer Umsatz)', () => {
    const enc = verschluesselUmsatzzaehler(0n, cert, kassenId, 1)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 1)
    expect(dec).toBe(0n)
  })

  it('Negativer Wert (Storno, -99999 Cent)', () => {
    const enc = verschluesselUmsatzzaehler(-99999n, cert, kassenId, 1)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 1)
    expect(dec).toBe(-99999n)
  })

  it('Sehr großer positiver Wert (Int64-Max = 9223372036854775807)', () => {
    const max = 9223372036854775807n  // 2^63 - 1
    const enc = verschluesselUmsatzzaehler(max, cert, kassenId, 99)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 99)
    expect(dec).toBe(max)
  })

  it('Negativer Extremwert (Int64-Min = -9223372036854775808)', () => {
    const min = -9223372036854775808n  // -(2^63)
    const enc = verschluesselUmsatzzaehler(min, cert, kassenId, 1)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 1)
    expect(dec).toBe(min)
  })

  it('Einzelner Cent (1)', () => {
    const enc = verschluesselUmsatzzaehler(1n, cert, kassenId, 1)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 1)
    expect(dec).toBe(1n)
  })

  it('Falscher Schlüssel liefert falsches Ergebnis', () => {
    const original = 1000n
    const enc = verschluesselUmsatzzaehler(original, cert, kassenId, 1)
    const andereKasse = 'ANDERE-KASSE'
    const dec = entschluesselUmsatzzaehler(enc, cert, andereKasse, 1)
    expect(dec).not.toBe(original)
  })

  it('Falsche Belegnummer liefert falsches Ergebnis', () => {
    const original = 50000n
    const enc = verschluesselUmsatzzaehler(original, cert, kassenId, 1)
    const dec = entschluesselUmsatzzaehler(enc, cert, kassenId, 2)
    expect(dec).not.toBe(original)
  })

  it('Verschlüsselung ist 8 Bytes für alle Grenzwerte', () => {
    const werte = [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n, 999999999999n]
    for (const wert of werte) {
      const enc = verschluesselUmsatzzaehler(wert, cert, kassenId, 1)
      expect(enc).toHaveLength(8)
    }
  })

  it('Schlüsselableitung: andere KassenID → komplett anderer Schlüssel', () => {
    const k1 = deriveAesKey(cert, 'KASSE-A')
    const k2 = deriveAesKey(cert, 'KASSE-B')
    expect(k1.equals(k2)).toBe(false)
    expect(k1).toHaveLength(32)
    expect(k2).toHaveLength(32)
  })

  it('IV-Kodierung: Belegnummer 0 → erste 8 Bytes sind 0', () => {
    const iv = belegNummerZuIV(0)
    expect(iv).toHaveLength(16)
    expect(iv.readBigUInt64BE(8)).toBe(0n)
  })

  it('IV-Kodierung: Große Belegnummer (2^32 - 1)', () => {
    const grosseNummer = 0xFFFFFFFF  // 4294967295
    const iv = belegNummerZuIV(grosseNummer)
    expect(iv.readBigUInt64BE(8)).toBe(BigInt(grosseNummer))
  })

  it('Umsatzzähler-Roundtrip mit echtem SEE-Zertifikat', async () => {
    const testSee = await generateSEE({
      kassenId:   'AES-TEST-KASSE',
      uid:        'ATU11223344',
      firmenname: 'AES Test GmbH',
    })
    const wert = 123456789n
    const enc = verschluesselUmsatzzaehler(wert, testSee.zertifikatDER, testSee.kassenId, 42)
    const dec = entschluesselUmsatzzaehler(enc, testSee.zertifikatDER, testSee.kassenId, 42)
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

  it('jeder Belegtyp erzeugt einen gültigen maschinenlesbaren Code', async () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'startSig'

    for (let i = 0; i < belegTypen.length; i++) {
      const typ = belegTypen[i]!
      const raw: RawBeleg = {
        kassenId:     'HAERTE-KASSE-001',
        belegNummer:  i + 2,
        datumUhrzeit: new Date('2026-01-15T10:00:00'),
        belegTyp:     typ,
        positionen:   typ === 'Barzahlungsbeleg' || typ === 'Stornobeleg'
          ? [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }]
          : [],
      }
      const beleg = signiereBeleg(raw, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert

      expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT_/)
      expect(beleg.signaturwert).toBeTruthy()
      expect(beleg.belegTyp).toBe(typ)
    }
  })

  it('Startbeleg: Umsatzzähler bleibt 0', () => {
    const { beleg, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    expect(kontext.umsatzzaehler.aktuell).toBe(0n)
    expect(beleg.belegTyp).toBe('Startbeleg')
  })

  it('Barzahlungsbeleg: Umsatzzähler steigt', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'X', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(1000n)
  })

  it('Stornobeleg: Umsatzzähler sinkt (negativer Betrag)', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    // Erst Barzahlung
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Kaffee', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    }, kontext)
    kontext.letzterSignaturwert = 'sig1'

    const vorStorno = kontext.umsatzzaehler.aktuell
    // Dann Storno (negative Menge → negativer Betrag)
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 3,
      datumUhrzeit: new Date(), belegTyp: 'Stornobeleg',
      positionen: [{ bezeichnung: 'Kaffee (Storno)', menge: -1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    }, kontext)

    expect(kontext.umsatzzaehler.aktuell).toBe(vorStorno - 350n)
  })

  it('Monatsbeleg: ändert Umsatzzähler NICHT', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    const vorher = kontext.umsatzzaehler.aktuell
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Monatsbeleg',
      positionen: [],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('Jahresbeleg: ändert Umsatzzähler NICHT', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    const vorher = kontext.umsatzzaehler.aktuell
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Jahresbeleg',
      positionen: [],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('Trainingsbeleg: ändert Umsatzzähler NICHT', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    const vorher = kontext.umsatzzaehler.aktuell
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Trainingsbeleg',
      positionen: [{ bezeichnung: 'Schulung', menge: 1, einzelpreisBreutto: 5000, mwstSatz: 'normal' }],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('Schlussbeleg: ändert Umsatzzähler NICHT', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig0'
    const vorher = kontext.umsatzzaehler.aktuell
    signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Schlussbeleg',
      positionen: [],
    }, kontext)
    expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('QR-Code-Format: alle 13 Felder vorhanden (Barzahlungsbeleg)', () => {
    const { kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = 'startSig'
    const beleg = signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date('2026-06-16T09:00:00'), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' }],
    }, kontext)

    // _R1-AT_{KID}_{BNR}_{BDT}_{BS-N}_{BS-E1}_{BS-E2}_{BS-0}_{BS-B}_{BSAU}_{ZKSN}_{BSKBV}_{SIG}
    const teile = beleg.maschinenlesbareCode.split('_')
    // Hinweis: das erste Element ist leer weil der Code mit '_' beginnt
    expect(teile.length).toBeGreaterThanOrEqual(13)
    expect(beleg.maschinenlesbareCode).toContain('R1-AT')
    expect(beleg.maschinenlesbareCode).toContain('HAERTE-KASSE-001')
  })
})

// ---------------------------------------------------------------------------
// 4. DEP7-Format
// ---------------------------------------------------------------------------

describe('DEP7-Format', () => {
  it('valider Export mit 50 Belegen – alle validiert', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const belege: SignedBeleg[] = [start]

    for (let i = 2; i <= 51; i++) {
      const beleg = signiereBeleg({
        kassenId: 'HAERTE-KASSE-001', belegNummer: i,
        datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'Pos', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    const dep = erstelleDEP7Export(belege, see, 'HAERTE-KASSE-001')
    const result = validiereDEP7(dep)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(51)
    expect(result.fehler).toHaveLength(0)
  })

  it('DEP7-JSON: Serialisierung und Deserialisierung erhält alle Daten', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const beleg2 = signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' }],
    }, kontext)

    const dep     = erstelleDEP7Export([start, beleg2], see, 'HAERTE-KASSE-001')
    const json    = dep7ZuJson(dep)
    const parsed  = dep7AusJson(json)
    const result  = validiereDEP7(parsed)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(2)
    expect(parsed.kassenId).toBe('HAERTE-KASSE-001')
    expect(parsed.Belege).toHaveLength(1)
    expect(parsed.Belege[0]?.Belege).toHaveLength(2)
  })

  it('DEP7: jedes Paket enthält Signaturzertifikat', () => {
    const { beleg: start } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const dep = erstelleDEP7Export([start], see, 'HAERTE-KASSE-001')

    for (const pkg of dep.Belege) {
      expect(pkg.Signaturzertifikat).toBeTruthy()
      expect(pkg.Signaturzertifikat.length).toBeGreaterThan(0)
    }
  })

  it('DEP7: alle Belegcodes beginnen mit _R1-AT_', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    kontext.letzterSignaturwert = start.signaturwert
    const beleg2 = signiereBeleg({
      kassenId: 'HAERTE-KASSE-001', belegNummer: 2,
      datumUhrzeit: new Date(), belegTyp: 'Monatsbeleg',
      positionen: [],
    }, kontext)

    const dep = erstelleDEP7Export([start, beleg2], see, 'HAERTE-KASSE-001')

    for (const pkg of dep.Belege) {
      for (const code of pkg.Belege) {
        expect(code).toMatch(/^_R1-AT_/)
      }
    }
  })

  it('DEP7: exportDatum ist gültiges ISO 8601', () => {
    const { beleg: start } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const dep = erstelleDEP7Export([start], see, 'HAERTE-KASSE-001')
    const parsed = new Date(dep.exportDatum)
    expect(parsed.getTime()).not.toBeNaN()
  })

  it('DEP7: ungültiger Code wird als Fehler gemeldet', () => {
    const dep = {
      exportDatum: new Date().toISOString(),
      kassenId:    'TEST',
      Belege: [{
        Signaturzertifikat: 'CERT',
        Zertifizierungsstellen: [],
        Belege: ['KEIN_GUELTIGER_CODE'],
      }],
    }
    const result = validiereDEP7(dep)
    expect(result.gueltig).toBe(false)
    expect(result.fehler.length).toBeGreaterThan(0)
  })

  it('DEP7: Signaturkette der Belege bleibt nach DEP7-Roundtrip rekonstruierbar', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('HAERTE-KASSE-001', see)
    const alleSignedBelege: SignedBeleg[] = [start]

    for (let i = 2; i <= 5; i++) {
      const beleg = signiereBeleg({
        kassenId: 'HAERTE-KASSE-001', belegNummer: i,
        datumUhrzeit: new Date(), belegTyp: 'Barzahlungsbeleg',
        positionen: [{ bezeichnung: 'X', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      alleSignedBelege.push(beleg)
    }

    // Originalkette ist valide
    expect(pruefeKette(alleSignedBelege)).toBe(true)

    // DEP7-Export und Re-Validierung
    const dep    = erstelleDEP7Export(alleSignedBelege, see, 'HAERTE-KASSE-001')
    const result = validiereDEP7(dep)
    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(5)
  })
})
