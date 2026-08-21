/**
 * parseTischEingabe: Bereiche mit und ohne Buchstaben-Präfix.
 * Anlass: „T1-T5" druckte EIN Etikett mit dem Text „T1-T5" statt fünf
 * Etiketten T1…T5 (Test-PC-Befund).
 */

import { describe, it, expect } from 'vitest'
import { parseTischEingabe } from './TischEtikettenModal'

describe('parseTischEingabe', () => {
  it('reiner Zahlenbereich wie bisher', () => {
    expect(parseTischEingabe('1-4')).toEqual(['1', '2', '3', '4'])
  })

  it('Bereich mit Buchstaben-Präfix auf beiden Seiten', () => {
    expect(parseTischEingabe('T1-T5')).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
  })

  it('Bereich mit Präfix nur links', () => {
    expect(parseTischEingabe('T1-5')).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
  })

  it('Präfix mit Leerzeichen („Tisch 1-8")', () => {
    expect(parseTischEingabe('Tisch 1-Tisch 3')).toEqual(['Tisch 1', 'Tisch 2', 'Tisch 3'])
  })

  it('führende Nullen bleiben erhalten', () => {
    expect(parseTischEingabe('T01-T03')).toEqual(['T01', 'T02', 'T03'])
  })

  it('verdrehte Grenzen werden sortiert', () => {
    expect(parseTischEingabe('T5-T3')).toEqual(['T3', 'T4', 'T5'])
  })

  it('unterschiedliche Präfixe sind KEIN Bereich (einzelner Name)', () => {
    expect(parseTischEingabe('T1-B5')).toEqual(['T1-B5'])
  })

  it('Einzelnamen und Kombinationen', () => {
    expect(parseTischEingabe('Bar, Terrasse 3, T1-T2')).toEqual(['Bar', 'Terrasse 3', 'T1', 'T2'])
  })

  it('Name mit Bindestrich ohne zwei Zahlen bleibt unverändert', () => {
    expect(parseTischEingabe('Stand-2')).toEqual(['Stand-2'])
  })

  it('übergroße Bereiche (>200) werden verworfen', () => {
    expect(parseTischEingabe('T1-T999')).toEqual([])
  })
})
