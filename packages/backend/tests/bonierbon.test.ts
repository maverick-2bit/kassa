/**
 * Tests für den Bonierbon-Generator.
 * Verifiziert, dass das erzeugte Format vom KDS-Parser (C:\kds\server.js) verstanden wird.
 *
 * Die KDS-Parser-Regeln (aus server.js extrahiert):
 *   - Zeile 1: enthält [A-Z]{2,3}\d{6,} (Bonnummer) UND "Bonierbon|Storno|Rechnung"
 *   - Zeile 2: enthält HH:MM(:SS)? UND DD.MM.YYYY
 *   - Bereich-Zeile: "Bereich: <text>", optional "/T(\d+)$" für Tisch
 *   - Benutzer-Zeile: "Benutzer: <text>"
 *   - Positionen: /^\d+\s+\S/  → "MENGE BEZEICHNUNG..."
 */

import { describe, it, expect } from 'vitest'
import { baueBonierbon, generiereBonNummer } from '../src/services/kds/bonierbon.js'

describe('baueBonierbon — KDS-Format-Compliance', () => {
  const baseInput = {
    bonNummer:   'AE420260210',
    belegnummer: 42,
    uhrzeit:     new Date('2026-05-20T14:30:15+02:00'),
    tisch:       '5',
    bereich:     'Innen',
    kellner:     'Mayr/Service',
    positionen: [
      { menge: 2, bezeichnung: 'Bier 0,5l - Ottakringer' },
      { menge: 1, bezeichnung: 'Schnitzelsemmel', details: 'ohne Saucen' },
    ],
  }

  it('Erste Zeile matcht KDS-Bonnummer-Regex', () => {
    const text  = baueBonierbon(baseInput)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/[A-Z]{2,3}\d{6,}/)
  })

  it('Erste Zeile enthält Typ-Marker "Bonierbon"', () => {
    const text  = baueBonierbon(baseInput)
    expect(text.split('\n')[0]).toMatch(/Bonierbon/)
  })

  it('Zweite Zeile enthält Uhrzeit und Datum', () => {
    const text  = baueBonierbon(baseInput)
    const z2 = text.split('\n')[1]
    expect(z2).toMatch(/\d{2}:\d{2}(?::\d{2})?/)
    expect(z2).toMatch(/\d{2}\.\d{2}\.\d{4}/)
  })

  it('Bereich-Zeile mit Tisch-Suffix', () => {
    const text = baueBonierbon(baseInput)
    expect(text).toMatch(/Bereich: Innen \/ T5/)
  })

  it('Bereich ohne explizites Bereich-Feld liefert nur Tisch', () => {
    const text = baueBonierbon({ ...baseInput, bereich: undefined })
    expect(text).toMatch(/Bereich: T5/)
  })

  it('Benutzer-Zeile korrekt formatiert', () => {
    const text = baueBonierbon(baseInput)
    expect(text).toMatch(/Benutzer: Mayr\/Service/)
  })

  it('Positionen mit Menge-Bezeichnung am Zeilenanfang', () => {
    const text  = baueBonierbon(baseInput)
    const lines = text.split('\n')
    const posLines = lines.filter((l) => /^\d+\s+\S/.test(l))
    expect(posLines).toHaveLength(2)
    expect(posLines[0]).toMatch(/^2 Bier/)
    expect(posLines[1]).toMatch(/^1 Schnitzelsemmel/)
  })

  it('Position mit Details: " - Detail" angehängt', () => {
    const text = baueBonierbon(baseInput)
    expect(text).toMatch(/1 Schnitzelsemmel - ohne Saucen/)
  })

  it('Footer "Bonierbon - Keine Rechnung!" vorhanden', () => {
    const text = baueBonierbon(baseInput)
    expect(text).toMatch(/Bonierbon - Keine Rechnung!/)
  })

  it('Endet mit Newline (für TCP-Stream)', () => {
    const text = baueBonierbon(baseInput)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('generiereBonNummer', () => {
  it('Default-Präfix AE + 9 Ziffern', () => {
    const nr = generiereBonNummer()
    expect(nr).toMatch(/^AE\d{9}$/)
  })

  it('Custom Präfix', () => {
    expect(generiereBonNummer('KX')).toMatch(/^KX\d{9}$/)
  })

  it('Matcht den KDS-Parser-Regex', () => {
    const nr = generiereBonNummer()
    expect(nr).toMatch(/[A-Z]{2,3}\d{6,}/)
  })
})
