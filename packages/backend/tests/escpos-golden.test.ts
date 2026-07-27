/**
 * Golden-Master-Tests für komplette ESC/POS-Byte-Ströme.
 *
 * Jede Layout-Funktion wird mit fixen Eingaben aufgerufen und das Ergebnis
 * Byte für Byte gegen eine eingefrorene Referenzdatei (tests/fixtures/
 * escpos-golden/*.bin|.txt) verglichen. Jede unbeabsichtigte Änderung am
 * Druckbild (Layout-Umbauten, Befehls-Reihenfolge, Codepage, Schnitt) fällt
 * damit sofort auf — die Lehre aus den Etiketten-Iterationen um v0.7.108-113.
 *
 * Gewollte Layout-Änderung? Referenzen neu erzeugen und MIT committen:
 *   UPDATE_GOLDEN=1 npx vitest run tests/escpos-golden.test.ts
 *
 * Determinismus: TZ wird auf Europe/Vienna gepinnt (formatDatum nutzt die
 * Prozess-Zeitzone) und die „Gedruckt:"-Stempel laufen über Fake-Timer.
 */

process.env.TZ = 'Europe/Vienna'

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BelegResponse, Tagesabschluss } from '@kassa/shared'
import { baueBon, baueGutscheinBon, baueInventurBon, baueTischEtikett, baueWareneingangBon, baueZBon } from '../src/services/escpos/layout.js'
import { baueBonierbon } from '../src/services/kds/bonierbon.js'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'escpos-golden')
const UPDATE     = process.env.UPDATE_GOLDEN === '1'

function pruefeGolden(name: string, daten: Buffer | string): void {
  const bytes = typeof daten === 'string' ? Buffer.from(daten, 'utf8') : daten
  const datei = join(GOLDEN_DIR, name)

  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(datei, bytes)
    return
  }
  if (!existsSync(datei)) {
    throw new Error(
      `Golden-Datei fehlt: ${name} — mit UPDATE_GOLDEN=1 npx vitest run tests/escpos-golden.test.ts erzeugen und committen.`,
    )
  }

  const golden = readFileSync(datei)
  if (!golden.equals(bytes)) {
    let i = 0
    while (i < Math.min(golden.length, bytes.length) && golden[i] === bytes[i]) i++
    const hex = (b: Buffer) => b.subarray(Math.max(0, i - 8), i + 8).toString('hex')
    throw new Error(
      `Golden-Master "${name}" weicht ab @ Offset ${i} ` +
      `(erwartet …${hex(golden)}…, erhalten …${hex(bytes)}…; Länge ${golden.length} → ${bytes.length}). ` +
      `Gewollte Layout-Änderung? → UPDATE_GOLDEN=1 npx vitest run tests/escpos-golden.test.ts`,
    )
  }
}

function fixBeleg(): BelegResponse {
  return {
    id:           '11111111-1111-1111-1111-111111111111',
    belegNummer:  42,
    belegDatum:   '2026-05-20T14:30:00Z',
    belegTyp:     'Barzahlungsbeleg',
    betraege:     { normal: 0, ermaessigt1: 700, ermaessigt2: 0, null: 0, besonders: 0 },
    summeBarCent:      700,
    summeKarteCent:    0,
    summeSonstigeCent: 0,
    gesamtbetragCent:  700,
    positionen: [
      { bezeichnung: 'Espresso',     menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' },
    ],
    zertifikatSn:                'AB-1234',
    sigVorbeleg:                 'vor',
    signaturwert:                'sig',
    umsatzzaehlerVerschluesselt: 'enc',
    maschinenlesbareCode:        '_R1-AT_KASSE-001_42_2026-05-20T16:30:00_0,00_7,00_0,00_0,00_0,00_enc_AB-1234_vor_sig',
    createdAt:                   '2026-05-20T14:30:01Z',
  }
}

const MANDANT = { firmenname: 'Golden GmbH', uid: 'ATU12345678', kassenId: 'KASSE-001' }

describe('ESC/POS Golden-Master', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z')) // „Gedruckt:"-Stempel
  })
  afterAll(() => vi.useRealTimers())

  it('Barzahlungs-Bon 80mm (42 Zeichen) mit RKSV-QR', () => {
    pruefeGolden('bon-barzahlung-42.bin', baueBon(fixBeleg(), MANDANT, { breite: 42 }))
  })

  it('Nullbeleg 58mm (32 Zeichen)', () => {
    pruefeGolden('bon-nullbeleg-32.bin', baueBon(
      { ...fixBeleg(), belegTyp: 'Nullbeleg', positionen: [], gesamtbetragCent: 0,
        betraege: { normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0 },
        summeBarCent: 0, summeKarteCent: 0, summeSonstigeCent: 0 },
      MANDANT, { breite: 32 },
    ))
  })

  it('Storno-Bon 42 (negative Beträge)', () => {
    pruefeGolden('bon-storno-42.bin', baueBon(
      { ...fixBeleg(), belegNummer: 43, belegTyp: 'Stornobeleg', gesamtbetragCent: -700,
        betraege: { normal: 0, ermaessigt1: -700, ermaessigt2: 0, null: 0, besonders: 0 },
        summeBarCent: -700,
        positionen: [{ bezeichnung: 'Espresso', menge: -2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
        verweisBelegId: '11111111-1111-1111-1111-111111111111' },
      MANDANT, { breite: 42 },
    ))
  })

  it('Tisch-Etikett ohne QR (große Nummer + Branding)', () => {
    pruefeGolden('etikett-ohne-qr-42.bin', baueTischEtikett('5', { breite: 42, firmenname: 'Golden GmbH' }))
  })

  it('Tisch-Etikett mit Gast-QR (gestapeltes Layout)', () => {
    pruefeGolden('etikett-mit-qr-42.bin', baueTischEtikett('7', {
      breite: 42, firmenname: 'Golden GmbH',
      qrUrl: 'http://192.168.1.10:8082/gast?kasseId=abc&tisch=7',
    }))
  })

  it('Gutschein-Bon 42 (frisch — Wert riesig, Code + QR)', () => {
    pruefeGolden('gutschein-42.bin', baueGutscheinBon({
      breite: 42, firmenname: 'Golden GmbH',
      code: 'GS-A3B7-X2Y9', nummer: 12,
      datum: '2026-05-20T14:30:00Z',
      betragCent: 5000, restCent: 5000,
      gueltigBis: '2027-05-20',
    }))
  })

  it('Inventur-Bon 42 (nur Abweichungen)', () => {
    pruefeGolden('inventur-42.bin', baueInventurBon({
      breite: 42, firmenname: 'Golden GmbH',
      bezeichnung: 'Inventur 2026-05-20',
      datum: '2026-05-20T14:30:00Z',
      erstelltVon: 'Chef',
      abweichungen: [
        { bezeichnung: 'Bier vom Fass', sollMenge: 40, istMenge: 37 },
        { bezeichnung: 'Wiener Schnitzel', sollMenge: 12, istMenge: 14 },
      ],
      gesamtPositionen: 25,
      gezaehlt: 25,
    }))
  })

  it('Inventur-Bon 32 (Zwischenstand ohne Abweichung)', () => {
    pruefeGolden('inventur-zwischenstand-32.bin', baueInventurBon({
      breite: 32,
      bezeichnung: 'Zähltag',
      datum: '2026-05-20T14:30:00Z',
      erstelltVon: 'Service',
      zwischenstand: true,
      abweichungen: [],
      gesamtPositionen: 8,
      gezaehlt: 3,
    }))
  })

  it('Wareneingangs-Bon 42 (mit Lieferant)', () => {
    pruefeGolden('wareneingang-42.bin', baueWareneingangBon({
      breite: 42, firmenname: 'Golden GmbH',
      lieferant: 'Getränke Müller',
      datum: '2026-05-20T14:30:00Z',
      erfasstVon: 'Lager',
      positionen: [
        { bezeichnung: 'Bier vom Fass', menge: 24 },
        { bezeichnung: 'Almdudler', menge: 12 },
      ],
    }))
  })

  it('Gutschein-Bon 32 (teileingelöst — Restwert-Zeile)', () => {
    pruefeGolden('gutschein-teil-32.bin', baueGutscheinBon({
      breite: 32,
      code: 'GS-TT99-K1L2', nummer: 13,
      datum: '2026-05-20T14:30:00Z',
      betragCent: 10000, restCent: 2550,
      gueltigBis: null,
    }))
  })

  it('Z-Bon (Tagesabschluss) 42', () => {
    const ta: Tagesabschluss = {
      datum:   '2026-05-20',
      kasseId: '22222222-2222-2222-2222-222222222222',
      anzahlBarzahlungsbelege: 12,
      anzahlStornobelege:      1,
      nettoUmsatzCent:         84500,
      barCent:                 50000,
      karteCent:               34500,
      sonstigCent:             0,
      mwst: [
        { satzKey: 'normal',      label: '20% Normalsteuersatz', bruttoCent: 60000, nettoCent: 50000, ustCent: 10000 },
        { satzKey: 'ermaessigt1', label: '10% ermäßigt',         bruttoCent: 24500, nettoCent: 22273, ustCent: 2227 },
      ],
    }
    pruefeGolden('zbon-42.bin', baueZBon(ta, MANDANT, { breite: 42 }))
  })

  it('Bonierbon (Text-Layout, Asello-Stil)', () => {
    pruefeGolden('bonierbon.txt', baueBonierbon({
      bonNummer:   '0042',
      belegnummer: 42,
      uhrzeit:     new Date('2026-05-20T12:34:00Z'),
      tisch:       '5',
      bereich:     'Terrasse',
      kellner:     'Anna',
      positionen: [
        { menge: 2, bezeichnung: 'Bier vom Fass' },
        { menge: 1, bezeichnung: 'Schnitzel', details: 'ohne Zitrone' },
      ],
    }))
  })
})
