/**
 * ESC/POS: Text ist Nutzdaten und darf dem Drucker keine Befehle unterschieben.
 *
 * ESC (0x1B) und GS (0x1D) leiten Druckerbefehle ein: Schublade öffnen (ESC p), Bon abschneiden (GS V),
 * Barcodes drucken, Speicher und Einstellungen beschreiben. Texte kommen auch von Gästen — die Tischnummer
 * der öffentlichen Gast-Bestellung steht auf dem Bon in Küche und Bar. Früher gab encodeText jedes Byte
 * unter 0x80 unverändert weiter.
 */

import { describe, it, expect } from 'vitest'
import { encodeText, textLine, ESC, GS, LF } from '../src/services/escpos/commands.js'

describe('encodeText: Steuerzeichen', () => {
  it('lässt gewöhnlichen Text unverändert (ASCII, Umlaute, Euro)', () => {
    const ascii = 'Tisch 5 Ecke (Bar) 12,50 #A-7'
    expect([...encodeText(ascii)]).toEqual([...Buffer.from(ascii, 'latin1')])
    expect([...encodeText('äöüß€')]).toEqual([0x84, 0x94, 0x81, 0xE1, 0xD5])   // CP858
  })

  it('entfernt ESC, GS und alle anderen Steuerzeichen — der übrige Text bleibt', () => {
    // ESC p 0 25 öffnet die Schublade, GS V 0 schneidet ab, ESC @ setzt den Drucker zurück
    const boese = 'T\x1bp\x00\x19-\x1dV\x00-\x1b@-\x07\x7f\x08\r\tX'
    const bytes = [...encodeText(boese)]

    expect(bytes).not.toContain(ESC)
    expect(bytes).not.toContain(GS)
    for (const b of bytes) expect(b >= 0x20 && b !== 0x7f, `Steuerbyte 0x${b.toString(16)} im Ausgang`).toBe(true)
    // "p", "V" und "@" sind gewöhnlicher Text und bleiben — nur die Befehlseinleitung fällt weg
    expect(Buffer.from(bytes).toString('latin1')).toBe('Tp-V-@-X')
  })

  it('behält den Zeilenvorschub (mehrzeilige Texte)', () => {
    expect([...encodeText('A\nB')]).toEqual([0x41, LF, 0x42])
  })

  it('textLine hängt genau einen Zeilenvorschub an, auch wenn der Text Befehle enthält', () => {
    expect([...textLine('Tisch\x1bp\x00')]).toEqual([...Buffer.from('Tischp'), LF])
  })
})
