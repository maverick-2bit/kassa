/**
 * Tests für das ESC/POS-Modul.
 * Verifizieren die generierten Byte-Sequenzen gegen die Spezifikation.
 */

import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import * as ep from '../src/services/escpos/commands.js'
import { baueBon, zweispaltig } from '../src/services/escpos/layout.js'
import type { BelegResponse } from '@kassa/shared'

// ---------------------------------------------------------------------------
// Low-Level Commands
// ---------------------------------------------------------------------------

describe('ESC/POS Commands', () => {
  it('init liefert ESC @', () => {
    expect(ep.init()).toEqual(Buffer.from([0x1B, 0x40]))
  })

  it('align center', () => {
    expect(ep.align('center')).toEqual(Buffer.from([0x1B, 0x61, 1]))
  })

  it('align right', () => {
    expect(ep.align('right')).toEqual(Buffer.from([0x1B, 0x61, 2]))
  })

  it('font bold + doubleHeight', () => {
    const b = ep.font({ bold: true, doubleHeight: true })
    expect(b[2]).toBe(0b0001_1000)
  })

  it('cut schiebt genug vor (4 Zeilen) und schneidet dann (GS V 66 0)', () => {
    // Kopf-zu-Messer-Abstand: ohne Vorschub bleibt das Bon-Ende im Gerät stecken.
    expect(ep.cut()).toEqual(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1D, 0x56, 0x42, 0]))
  })

  it('selectCodepage 19 (CP858)', () => {
    expect(ep.selectCodepage(19)).toEqual(Buffer.from([0x1B, 0x74, 19]))
  })

  it('encodeText: ASCII durchgereicht', () => {
    expect(ep.encodeText('Hello')).toEqual(Buffer.from('Hello'))
  })

  it('encodeText: deutsche Umlaute → CP858', () => {
    const result = ep.encodeText('äöüß')
    expect(result).toEqual(Buffer.from([0x84, 0x94, 0x81, 0xE1]))
  })

  it('encodeText: Euro-Zeichen → CP858', () => {
    expect(ep.encodeText('€')).toEqual(Buffer.from([0xD5]))
  })

  it('encodeText: unbekannte Zeichen → "?"', () => {
    expect(ep.encodeText('Δ')).toEqual(Buffer.from([0x3F]))
  })

  it('qrCode: enthält Daten und Print-Befehl', () => {
    const qr = ep.qrCode('TEST', 6, 'L')
    // Sollte die Daten 'TEST' enthalten
    expect(qr.includes(Buffer.from('TEST'))).toBe(true)
    // Sollte den Print-Command (GS ( k 3 0 49 81 48) am Ende haben
    const printCmd = Buffer.from([0x1D, 0x28, 0x6B, 3, 0, 49, 81, 48])
    expect(qr.subarray(qr.length - 8)).toEqual(printCmd)
  })

  it('kickDrawer Pin 2', () => {
    const b = ep.kickDrawer(2)
    expect(b[0]).toBe(0x1B)
    expect(b[1]).toBe(0x70)
    expect(b[2]).toBe(0) // Pin 2
  })
})

// ---------------------------------------------------------------------------
// Layout-Helfer
// ---------------------------------------------------------------------------

describe('zweispaltig()', () => {
  it('füllt mit Leerzeichen auf', () => {
    expect(zweispaltig('Bar', '7,00 EUR', 20)).toBe('Bar         7,00 EUR')
  })

  it('Truncate wenn links zu lang', () => {
    const result = zweispaltig('Sehr langer Artikelname mit vielen Wörtern', '7,00', 20)
    expect(result.length).toBe(20)
    expect(result).toMatch(/^Sehr langer.*7,00$/)
  })
})

// ---------------------------------------------------------------------------
// Bon-Layout: End-to-End
// ---------------------------------------------------------------------------

function dummyBeleg(): BelegResponse {
  return {
    id:           '11111111-1111-1111-1111-111111111111',
    belegNummer:  42,
    belegDatum:   '2026-05-20T14:30:00Z',
    belegTyp:     'Barzahlungsbeleg',
    betraege: {
      normal:      0,
      ermaessigt1: 700,
      ermaessigt2: 0,
      null:        0,
      besonders:   0,
    },
    summeBarCent:      700,
    summeKarteCent:    0,
    summeSonstigeCent: 0,
    gesamtbetragCent:  700,
    positionen: [
      { bezeichnung: 'Espresso', menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' },
    ],
    zertifikatSn:                'AB-1234',
    sigVorbeleg:                 'vor',
    signaturwert:                'sig',
    umsatzzaehlerVerschluesselt: 'enc',
    maschinenlesbareCode:        '_R1-AT_KASSE-001_42_...',
    createdAt:                   '2026-05-20T14:30:01Z',
  }
}

describe('baueBon()', () => {
  it('produziert vollständigen Bon', () => {
    const bytes = baueBon(
      dummyBeleg(),
      { firmenname: 'Mustermann GmbH', uid: 'ATU12345678', kassenId: 'KASSE-001' },
      { breite: 42 },
    )
    // Beginnt mit ESC @ (Init)
    expect(bytes[0]).toBe(0x1B)
    expect(bytes[1]).toBe(0x40)
    // Enthält Firmenname (uppercase)
    expect(bytes.includes(Buffer.from('MUSTERMANN'))).toBe(true)
    // Enthält UID
    expect(bytes.includes(Buffer.from('ATU12345678'))).toBe(true)
    // Enthält QR-Code-Inhalt
    expect(bytes.includes(Buffer.from('_R1-AT_KASSE-001'))).toBe(true)
    // Endet mit Vorschub (4×LF) + Cut-Command (GS V 66 0)
    const cutCmd = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x1D, 0x56, 0x42, 0])
    expect(bytes.subarray(bytes.length - cutCmd.length)).toEqual(cutCmd)
  })

  it('produziert auch Bon für Nullbeleg (leere Positionen)', () => {
    const bytes = baueBon(
      { ...dummyBeleg(), belegTyp: 'Nullbeleg', positionen: [], gesamtbetragCent: 0,
        betraege: { normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0 },
        summeBarCent: 0, summeKarteCent: 0, summeSonstigeCent: 0 },
      { firmenname: 'Test', uid: 'ATU12345678', kassenId: 'K1' },
      { breite: 32 },
    )
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.includes(Buffer.from('Nullbeleg'))).toBe(true)
    expect(bytes.includes(Buffer.from('(keine Positionen)'))).toBe(true)
  })

  it('produziert Bon mit korrekter Breite für 58mm', () => {
    const bytes = baueBon(
      dummyBeleg(),
      { firmenname: 'Test', uid: 'ATU12345678', kassenId: 'K1' },
      { breite: 32 },
    )
    // Trennlinie sollte 32 Bindestriche enthalten
    expect(bytes.includes(Buffer.from('-'.repeat(32)))).toBe(true)
    expect(bytes.includes(Buffer.from('-'.repeat(42)))).toBe(false)
  })
})
