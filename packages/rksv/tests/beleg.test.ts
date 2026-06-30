/**
 * Integrationstests für die vollständige Belegsignierung
 *
 * Prüft den gesamten RKSV-Ablauf:
 *   - SEE generieren
 *   - Startbeleg erstellen
 *   - Barzahlungsbelege signieren
 *   - Signaturkette validieren
 *   - Umsatzzähler-Konsistenz
 *   - DEP7-Export
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { generateSEE } from '../src/see.js'
import { RKSVKasse } from '../src/index.js'
import {
  signiereBeleg,
  erstelleStartbeleg,
  berechneBetraege,
  verifiziereBelegSignatur,
  Umsatzzaehler,
  type SignierungsKontext,
} from '../src/beleg.js'
import { pruefeKette } from '../src/crypto/chain.js'
import { erstelleDEP7Export, validiereDEP7 } from '../src/dep.js'
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
  it('summiert Beträge pro Steuersatz', () => {
    const betraege = berechneBetraege([
      { bezeichnung: 'Kaffee',    menge: 2, einzelpreisBreutto: 350,  mwstSatz: 'ermaessigt1' },
      { bezeichnung: 'Kuchen',    menge: 1, einzelpreisBreutto: 450,  mwstSatz: 'ermaessigt1' },
      { bezeichnung: 'Mineralwasser', menge: 3, einzelpreisBreutto: 250, mwstSatz: 'ermaessigt1' },
    ])
    expect(betraege.ermaessigt1).toBe(2 * 350 + 450 + 3 * 250)
    expect(betraege.normal).toBe(0)
    expect(betraege.null).toBe(0)
  })

  it('leere Positionen → alle Null', () => {
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
  it('hat Belegtyp Startbeleg', () => {
    const { beleg } = erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.belegTyp).toBe('Startbeleg')
  })

  it('hat Belegnummer 1', () => {
    const { beleg } = erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.belegNummer).toBe(1)
  })

  it('maschinenlesbareCode beginnt mit _R1-AT_', () => {
    const { beleg } = erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.maschinenlesbareCode).toMatch(/^_R1-AT_/)
  })

  it('sigVorbeleg entspricht dem SHA-256 von Null-Bytes (Startbeleg-Spezifikation)', () => {
    const { beleg } = erstelleStartbeleg('TEST-KASSE-001', see)
    const erwartet = Buffer
      .from('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925', 'hex')
      .toString('base64url')
    expect(beleg.sigVorbeleg).toBe(erwartet)
  })

  it('hat ein zertifikatSN', () => {
    const { beleg } = erstelleStartbeleg('TEST-KASSE-001', see)
    expect(beleg.zertifikatSN).toBeTruthy()
  })

  it('Umsatzzähler bleibt bei 0 (Startbeleg ändert nicht)', () => {
    const { kontext } = erstelleStartbeleg('TEST-KASSE-001', see)
    expect(kontext.umsatzzaehler.aktuell).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Barzahlungsbeleg
// ---------------------------------------------------------------------------

describe('signiereBeleg – Barzahlungsbeleg', () => {
  it('signiert einen einfachen Beleg', () => {
    const { kontext } = erstelleStartbeleg('TEST-KASSE-001', see)

    const raw: RawBeleg = {
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date('2026-01-01T12:00:00'),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Espresso', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' },
      ],
    }

    kontext.letzterSignaturwert = 'startbelegSig'
    const beleg = signiereBeleg(raw, kontext)

    expect(beleg.signaturwert).toBeTruthy()
    expect(beleg.maschinenlesbareCode).toContain('_R1-AT_')
    expect(beleg.betraege.ermaessigt1).toBe(350)
  })

  it('erhöht den Umsatzzähler', () => {
    const { kontext } = erstelleStartbeleg('TEST-KASSE-001', see)
    const vorher = kontext.umsatzzaehler.aktuell

    kontext.letzterSignaturwert = 'sig'
    signiereBeleg({
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

  it('Umsatzzähler ist korrekt im Beleg verschlüsselt', () => {
    const { kontext } = erstelleStartbeleg('TEST-KASSE-001', see)
    kontext.letzterSignaturwert = 'sig'

    const beleg = signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 2, einzelpreisBreutto: 500, mwstSatz: 'normal' },
      ],
    }, kontext)

    const encrypted  = Buffer.from(beleg.umsatzzaehlerVerschluesselt, 'base64url')
    const decrypted  = entschluesselUmsatzzaehler(encrypted, see.zertifikatDER, see.kassenId, 2)
    expect(decrypted).toBe(1000n) // 2 × 500
  })
})

// ---------------------------------------------------------------------------
// Signaturkette
// ---------------------------------------------------------------------------

describe('Signaturkette', () => {
  it('drei aufeinanderfolgende Belege bilden eine valide Kette', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('TEST-KASSE-001', see)

    const belege = [start]

    for (let i = 2; i <= 3; i++) {
      const beleg = signiereBeleg({
        kassenId:     'TEST-KASSE-001',
        belegNummer:  i,
        datumUhrzeit: new Date(),
        belegTyp:     'Barzahlungsbeleg',
        positionen: [
          { bezeichnung: 'Artikel', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
        ],
      }, kontext)
      kontext.letzterSignaturwert = beleg.signaturwert
      belege.push(beleg)
    }

    expect(pruefeKette(belege)).toBe(true)
  })

  it('Kette ist ungültig wenn ein Signaturwert manipuliert wird', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('TEST-KASSE-001', see)

    const beleg2 = signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: 100, mwstSatz: 'normal' },
      ],
    }, kontext)

    // Signaturwert manipulieren
    const manipuliert = { ...start, signaturwert: 'MANIPULIERT' }
    expect(pruefeKette([manipuliert, beleg2])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifiziereBelegSignatur — Tamper-Detection auf Feldebene
// ---------------------------------------------------------------------------
// pruefeKette erkennt nur eine gebrochene Verkettung. Eine veränderte Position
// (z. B. nachträglich gesenkter Betrag in der DB) lässt die Kette intakt — nur
// die ECDSA-Signaturprüfung über die Felder deckt das auf.

describe('verifiziereBelegSignatur (Tamper-Detection)', () => {
  function signiereBarzahlung(betragCent: number) {
    const { kontext } = erstelleStartbeleg('TEST-KASSE-001', see)
    kontext.letzterSignaturwert = 'startbelegSig'
    return signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date('2026-03-15T10:30:00'),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Test', menge: 1, einzelpreisBreutto: betragCent, mwstSatz: 'normal' },
      ],
    }, kontext)
  }

  it('unveränderter Beleg verifiziert gegen das Zertifikat', () => {
    const beleg = signiereBarzahlung(2000)
    expect(verifiziereBelegSignatur(beleg, see.zertifikatDER)).toBe(true)
  })

  it('manipulierter Betrag wird erkannt', () => {
    const beleg = signiereBarzahlung(2000)
    const manipuliert = { ...beleg, betraege: { ...beleg.betraege, normal: 1000 } }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('manipulierte Belegnummer wird erkannt', () => {
    const beleg = signiereBarzahlung(2000)
    expect(verifiziereBelegSignatur({ ...beleg, belegNummer: 99 }, see.zertifikatDER)).toBe(false)
  })

  it('manipuliertes Datum wird erkannt', () => {
    const beleg = signiereBarzahlung(2000)
    const manipuliert = { ...beleg, datumUhrzeit: new Date('2026-03-15T10:30:01') }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('manipulierter Umsatzzähler wird erkannt', () => {
    const beleg = signiereBarzahlung(2000)
    const manipuliert = { ...beleg, umsatzzaehlerVerschluesselt: beleg.umsatzzaehlerVerschluesselt.slice(0, -2) + 'AA' }
    expect(verifiziereBelegSignatur(manipuliert, see.zertifikatDER)).toBe(false)
  })

  it('falsches Zertifikat verifiziert nicht', async () => {
    const beleg = signiereBarzahlung(2000)
    const fremd = await generateSEE({ kassenId: 'ANDERE-KASSE', uid: 'ATU00000000', firmenname: 'Fremd GmbH' })
    expect(verifiziereBelegSignatur(beleg, fremd.zertifikatDER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RKSVKasse Fassade
// ---------------------------------------------------------------------------

describe('RKSVKasse', () => {
  it('initialisiert und signiert Belege', () => {
    const { kasse, startbeleg } = RKSVKasse.initialisieren(see)

    expect(startbeleg.belegTyp).toBe('Startbeleg')
    expect(kasse.umsatzzaehlerCent).toBe(0n)

    const beleg = kasse.signiereBeleg({
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

  it('lässt sich aus DB-State wiederherstellen', () => {
    const { kasse: original } = RKSVKasse.initialisieren(see)
    const zaehlerStand = original.umsatzzaehlerCent
    const letzterSig   = original.letzterSignaturwert ?? ''

    const wiederhergestellt = RKSVKasse.wiederherstellen(see, zaehlerStand, letzterSig)
    expect(wiederhergestellt.umsatzzaehlerCent).toBe(zaehlerStand)
  })
})

// ---------------------------------------------------------------------------
// DEP7
// ---------------------------------------------------------------------------

describe('DEP7', () => {
  it('Export enthält alle Belege', () => {
    const { beleg: start, kontext } = erstelleStartbeleg('TEST-KASSE-001', see)

    const beleg2 = signiereBeleg({
      kassenId:     'TEST-KASSE-001',
      belegNummer:  2,
      datumUhrzeit: new Date(),
      belegTyp:     'Barzahlungsbeleg',
      positionen: [
        { bezeichnung: 'Artikel', menge: 1, einzelpreisBreutto: 500, mwstSatz: 'normal' },
      ],
    }, kontext)

    const dep = erstelleDEP7Export([start, beleg2], see, 'TEST-KASSE-001')
    const result = validiereDEP7(dep)

    expect(result.gueltig).toBe(true)
    expect(result.anzahlBelege).toBe(2)
    expect(result.fehler).toHaveLength(0)
  })
})
