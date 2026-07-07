/**
 * Integrationstests für die vollständige Belegsignierung
 *
 * Prüft den gesamten RKSV-Ablauf gemäß Detailspezifikation:
 *   - SEE generieren
 *   - Startbeleg erstellen (Verkettung über die Kassen-ID)
 *   - Barzahlungsbelege signieren (JWS ES256, BASE64_STD im QR)
 *   - Verkettung über den kompletten Vorbeleg-Code validieren
 *   - Umsatzzähler-Konsistenz (eigener AES-Schlüssel)
 *   - DEP7-Export (Belege-Gruppe / Belege-kompakt als JWS)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { generateSEE } from '../src/see.js'
import { RKSVKasse } from '../src/index.js'
import {
  signiereBeleg,
  erstelleStartbeleg,
  berechneBetraege,
  verifiziereBelegSignatur,
  verifiziereQrCode,
  qrCodeZuJwsCompact,
  JWS_HEADER_B64URL,
  SEE_AUSFALL_SIGNATUR,
  istAusfallBeleg,
  type SignierungsKontext,
} from '../src/beleg.js'
import { pruefeKette, verkettungswertStartbeleg } from '../src/crypto/chain.js'
import { erstelleDEP7Export, validiereDEP7, dep7ZuJson, dep7AusJson } from '../src/dep.js'
import { entschluesselUmsatzzaehler } from '../src/crypto/aes-icm.js'
import type { RawBeleg, SEEConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Test-Setup
// ---------------------------------------------------------------------------

let see: SEEConfig

beforeAll(async () => {
  see = await generateSEE({
    kassenId:  'TEST-KASSE-001',
    uid:       'ATU12345678',
    firmenname: 'Test GmbH',
  })
})

// ---------------------------------------------------------------------------
// berechneBetraege
// ---------------------------------------------------------------------------

describe('berechneBetraege', () => {
  it('summiert Beträge pro Steuersatz', async () => {
    const betraege = berechneBetraege([
      { bezeichnung: 'Kaffee',    menge: 2, einzelpreisBreutto: 350,  mwstSatz: 'ermaessigt1' },
      { bezeichnung: 'Kuchen',    menge: 1, einzelpreisBreutto: 450,  mwstSatz: 'ermaessigt1' },
      { bezeichnung: 'Mineralwasser', menge: 3, einzelpreisBreutto: 250, mwstSatz: 'ermaessigt1' },
    ])
    expect(betraege.ermaessigt1).toBe(2 * 350 + 450 + 3 * 250)
    expect(betraege.normal).toBe(0)
    expect(betraege.null).toBe(0)
  })

  it('leere Positionen → alle Null', async () => {
    const betraege = berechneBetraege([])
    expect(betraege.normal).toBe(0)
    expect(betraege.ermaessigt1).toBe(0)
    expect(betraege.ermaessigt2).toBe(0)
    expect(betraege.null).toBe(0)
    expect(betraege.besonders).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Startbeleg
// ---------------------------------------------------------------------------

describe('erstelleStartbeleg', () => {
  it('hat Belegtyp Startbeleg', async () => {
    const { beleg } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.belegTyp).toBe('Startbeleg')
  })

  it('hat Belegnummer 1', async () => {
    const { beleg } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.belegNummer).toBe(1)
  })

  it('maschinenlesbareCode beginnt mit dem ZDA-Prefix _R1-AT0_ (Software-SEE)', async () => {
    const { beleg } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT0_/)
  })

  it('sigVorbeleg entspricht dem Verkettungswert der Kassen-ID (Startbeleg-Spezifikation)', async () => {
    const { beleg } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.sigVorbeleg).toBe(verkettungswertStartbeleg('TEST-KASSE-001'))
    // 8 Byte, Standard-Base64
    expect(Buffer.from(beleg.sigVorbeleg, 'base64')).toHaveLength(8)
  })

  it('hat ein zertifikatSN', async () => {
    const { beleg } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.zertifikatSN).toBeTruthy()
  })

  it('Umsatzzähler bleibt bei 0 (Startbeleg ändert nicht)', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    expect(kontext.umsatzzaehler.aktuell).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Barzahlungsbeleg
// ---------------------------------------------------------------------------

describe('signiereBeleg – Barzahlungsbeleg', () => {
  it('signiert einen einfachen Beleg (BASE64_STD-Signatur, JWS-Compact vorhanden)', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const raw: RawBeleg = {
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date('2026-01-01T12:00:00'),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Espresso', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' },
      ],
    }

    const beleg = await signiereBeleg(raw, kontext)

    expect(beleg.signaturwert).toBeTruthy()
    // Signatur im QR: Standard-Base64 einer 64-Byte-P1363-Signatur
    expect(Buffer.from(beleg.signaturwert, 'base64')).toHaveLength(64)
    expect(beleg.maschinenlesbareCode).toContain('_R1-AT0_')
    expect(beleg.betraege.ermaessigt1).toBe(350)
    // JWS-Compact: header.payload.signature mit fixem ES256-Header
    expect(beleg.jwsCompact.startsWith(`${JWS_HEADER_B64URL}.`)).toBe(true)
    expect(beleg.jwsCompact.split('.')).toHaveLength(3)
    expect(qrCodeZuJwsCompact(beleg.maschinenlesbareCode)).toBe(beleg.jwsCompact)
  })

  it('erhöht den Umsatzzähler', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    const vorher = kontext.umsatzzaehler.aktuell

    await signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 1000, mwstSatz: 'normal' },
      ],
    }, kontext)

    expect(kontext.umsatzzaehler.aktuell).toBe(vorher + 1000n)
  })

  it('Umsatzzähler ist korrekt im Beleg verschlüsselt (eigener AES-Schlüssel, BASE64_STD)', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const beleg = await signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 2, einzelpreisBreutto: 500, mwstSatz: 'normal' },
      ],
    }, kontext)

    const encrypted  = Buffer.from(beleg.umsatzzaehlerVerschluesselt, 'base64')
    const decrypted  = entschluesselUmsatzzaehler(encrypted, see.aesSchluessel, see.kassenId, 2)
    expect(decrypted).toBe(1000n) // 2 × 500
  })
})

// ---------------------------------------------------------------------------
// Verkettung
// ---------------------------------------------------------------------------

describe('Verkettung', () => {
  it('drei aufeinanderfolgende Belege bilden eine valide Kette', async () => {
    const { beleg: start, kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const belege = [start]

    for (let i = 2; i <= 3; i++) {
      const beleg = await signiereBeleg({
        kassenId:     'TEST-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: 'Artikel', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
        ],
      }, kontext)
      kontext.letzterBelegCode = beleg.maschinenlesbareCode
      belege.push(beleg)
    }

    expect(pruefeKette('TEST-KASSE-001', belege)).toBe(true)
  })

  it('Kette ist ungültig wenn der Vorbeleg-Code manipuliert wird', async () => {
    const { beleg: start, kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const beleg2 = await signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
      ],
    }, kontext)

    // Vorbeleg (Startbeleg) nachträglich manipulieren → Verkettung bricht
    const manipuliert = { ...start, maschinenlesbareCode: start.maschinenlesbareCode.replace('0,00', '1,00') }
    expect(pruefeKette('TEST-KASSE-001', [manipuliert, beleg2])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifiziereBelegSignatur — Tamper-Detection auf Feldebene
// ---------------------------------------------------------------------------
// pruefeKette erkennt nur eine gebrochene Verkettung. Eine veränderte Position
// (z. B. nachträglich gesenkter Betrag in der DB) lässt die Kette intakt — nur
// die ECDSA-Signaturprüfung über die Felder deckt das auf.

describe('verifiziereBelegSignatur (Tamper-Detection)', () => {
  async function signiereBarzahlung(betragCent: number) {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    const beleg = await signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date('2026-03-15T10:30:00'),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: betragCent, mwstSatz: 'normal' },
      ],
    }, kontext)
    return { ...beleg, zdaId: see.zdaId }
  }

  it('unveränderter Beleg verifiziert gegen das Zertifikat', async () => {
    const beleg = await signiereBarzahlung(2000)
    expect(verifiziereBelegSignatur(beleg, see.zertifikatDER)).toBe(true)
  })

  it('der komplette QR-Code verifiziert direkt (verifiziereQrCode)', async () => {
    const beleg = await signiereBarzahlung(2000)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, see.zertifikatDER)).toBe(true)
  })

  it('manipulierter Betrag wird erkannt', async () => {
    const beleg = await signiereBarzahlung(2000)
    const manipuliert = { ...beleg, betraege: { ...beleg.betraege, normal: 1000 } }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('manipulierte Belegnummer wird erkannt', async () => {
    const beleg = await signiereBarzahlung(2000)
    expect(verifiziereBelegSignatur({ ...beleg, belegNummer: 99 }, see.zertifikatDER)).toBe(false)
  })

  it('manipuliertes Datum wird erkannt', async () => {
    const beleg = await signiereBarzahlung(2000)
    const manipuliert = { ...beleg, datumUhrzeit: new Date('2026-03-15T10:30:01') }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('manipulierter Umsatzzähler wird erkannt', async () => {
    const beleg = await signiereBarzahlung(2000)
    const manipuliert = { ...beleg, umsatzzaehlerVerschluesselt: beleg.umsatzzaehlerVerschluesselt.slice(0, -2) + 'AA' }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('falsches Zertifikat verifiziert nicht', async () => {
    const beleg = await signiereBarzahlung(2000)
    const fremd = await generateSEE({ kassenId: 'ANDERE-KASSE', uid: 'ATU00000000', firmenname: 'Fremd GmbH' })
    expect(verifiziereBelegSignatur(beleg, fremd.zertifikatDER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SEE-Ausfall
// ---------------------------------------------------------------------------

describe('signiereBeleg – SEE-Ausfallmodus', () => {
  async function barzahlung(belegNummer: number, betragCent: number, kontext: SignierungsKontext, ausfall: boolean) {
    return signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer,
      datumUhrzeit: new Date('2026-04-01T09:00:00'),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: betragCent, mwstSatz: 'normal' }],
    }, kontext, { ausfallModus: ausfall })
  }

  it('setzt den BMF-Marker statt einer ECDSA-Signatur (BASE64_STD)', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    const beleg = await barzahlung(2, 2000, kontext, true)

    expect(beleg.signaturwert).toBe(SEE_AUSFALL_SIGNATUR)
    expect(beleg.ausgefallen).toBe(true)
    expect(istAusfallBeleg(beleg.signaturwert)).toBe(true)
    expect(beleg.maschinenlesbareCode.endsWith(`_${SEE_AUSFALL_SIGNATUR}`)).toBe(true)
    // Marker dekodiert (Standard-Base64) zur lesbaren BMF-Zeichenkette
    expect(Buffer.from(beleg.signaturwert, 'base64').toString('utf8'))
      .toBe('Sicherheitseinrichtung ausgefallen')
  })

  it('verschlüsselt den Umsatzzähler weiterhin und erhöht ihn', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    const vorher = kontext.umsatzzaehler.aktuell

    const beleg = await barzahlung(2, 1500, kontext, true)

    expect(kontext.umsatzzaehler.aktuell).toBe(vorher + 1500n)
    expect(beleg.umsatzzaehlerVerschluesselt).toBeTruthy()
    const decrypted = entschluesselUmsatzzaehler(
      Buffer.from(beleg.umsatzzaehlerVerschluesselt, 'base64'), see.aesSchluessel, see.kassenId, 2,
    )
    expect(decrypted).toBe(vorher + 1500n)
  })

  it('ein Ausfallbeleg verifiziert NICHT gegen das Zertifikat', async () => {
    const { kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)
    const beleg = await barzahlung(2, 2000, kontext, true)
    expect(verifiziereBelegSignatur({ ...beleg, zdaId: see.zdaId }, see.zertifikatDER)).toBe(false)
  })

  it('die Kette läuft über den Ausfall hinweg weiter (Marker-Beleg → Folgebeleg)', async () => {
    const { beleg: start, kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const ausfall = await barzahlung(2, 1000, kontext, true)
    kontext.letzterBelegCode = ausfall.maschinenlesbareCode

    const danach = await barzahlung(3, 500, kontext, false) // SEE wieder da, normal signiert
    kontext.letzterBelegCode = danach.maschinenlesbareCode

    expect(istAusfallBeleg(danach.signaturwert)).toBe(false)
    expect(pruefeKette('TEST-KASSE-001', [start, ausfall, danach])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RKSVKasse Fassade
// ---------------------------------------------------------------------------

describe('RKSVKasse', () => {
  it('initialisiert und signiert Belege', async () => {
    const { kasse, startbeleg } = await RKSVKasse.initialisieren(see)

    expect(startbeleg.belegTyp).toBe('Startbeleg')
    expect(kasse.umsatzzaehlerCent).toBe(0n)

    const beleg = await kasse.signiereBeleg({
      kassenId:     see.kassenId,
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 2000, mwstSatz: 'normal' },
      ],
    })

    expect(beleg.signaturwert).toBeTruthy()
    expect(kasse.umsatzzaehlerCent).toBe(2000n)
  })

  it('lässt sich aus DB-State wiederherstellen und setzt die Kette korrekt fort', async () => {
    const { kasse: original, startbeleg } = await RKSVKasse.initialisieren(see)
    const zaehlerStand = original.umsatzzaehlerCent
    const letzterCode  = original.letzterBelegCode ?? ''

    const wiederhergestellt = RKSVKasse.wiederherstellen(see, zaehlerStand, letzterCode)
    expect(wiederhergestellt.umsatzzaehlerCent).toBe(zaehlerStand)

    const folge = await wiederhergestellt.signiereBeleg({
      kassenId:     see.kassenId,
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [{ bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' }],
    })
    expect(pruefeKette(see.kassenId, [startbeleg, folge])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DEP7
// ---------------------------------------------------------------------------

describe('DEP7', () => {
  it('Export im Spec-Format: Belege-Gruppe mit Belege-kompakt (JWS)', async () => {
    const { beleg: start, kontext } = await erstelleStartbeleg('TEST-KASSE-001', see)

    const beleg2 = await signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Artikel', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' },
      ],
    }, kontext)

    const dep = erstelleDEP7Export([start, beleg2], see)
    const result = validiereDEP7(dep)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(2)
    expect(result.fehler).toHaveLength(0)

    // Spec-Feldnamen + JWS-Inhalt
    const gruppe = dep['Belege-Gruppe'][0]!
    expect(gruppe.Signaturzertifikat).toBe(see.zertifikatDER.toString('base64'))
    expect(gruppe['Belege-kompakt'][0]).toBe(start.jwsCompact)
    expect(gruppe['Belege-kompakt'][1]!.split('.')).toHaveLength(3)

    // JSON-Roundtrip erhält die Struktur
    const wieder = dep7AusJson(dep7ZuJson(dep))
    expect(validiereDEP7(wieder).anzahlBelege).toBe(2)
  })
})
