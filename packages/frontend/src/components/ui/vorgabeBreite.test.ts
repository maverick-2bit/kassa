/**
 * vorgabeBreite: `w-full` nur, wenn der Aufrufer keine eigene Breite setzt.
 * Anlass: Input hängte `className` an `block w-full …` an — im gebauten CSS steht
 * `.w-full` hinter `.w-20`/`.w-40`, also blieben Tisch und Kellner in der
 * Kontextleiste der Kasse je 216 px breit statt 80/160 px.
 */

import { describe, it, expect } from 'vitest'
import { vorgabeBreite } from './vorgabeBreite'

describe('vorgabeBreite', () => {
  it('ohne Breite des Aufrufers → volle Breite', () => {
    expect(vorgabeBreite('')).toBe('w-full')
    expect(vorgabeBreite('mt-1')).toBe('w-full')
    expect(vorgabeBreite('flex-1 font-mono tracking-wider')).toBe('w-full')
  })

  it('Breite des Aufrufers ersetzt die Vorgabe', () => {
    expect(vorgabeBreite('w-20 text-center')).toBe('')
    expect(vorgabeBreite('mt-1 w-40')).toBe('')
    expect(vorgabeBreite('h-8 w-32 text-xs')).toBe('')
    expect(vorgabeBreite('w-[12rem]')).toBe('')
    expect(vorgabeBreite('w-auto')).toBe('')
    expect(vorgabeBreite('size-8')).toBe('')
    expect(vorgabeBreite('w-full')).toBe('')
  })

  it('wichtig-Markierung vorne oder hinten zählt ebenfalls als Breite', () => {
    expect(vorgabeBreite('w-20!')).toBe('')
    expect(vorgabeBreite('!w-20')).toBe('')
  })

  it('präfixierte Breiten ergänzen die Vorgabe (stehen im CSS dahinter)', () => {
    expect(vorgabeBreite('sm:w-40')).toBe('w-full')
    expect(vorgabeBreite('mt-1 md:w-60')).toBe('w-full')
    // unpräfixiert + präfixiert: die unpräfixierte ersetzt die Vorgabe
    expect(vorgabeBreite('w-20 sm:w-40')).toBe('')
  })

  it('Mindest-/Höchstbreite, flex-basis und ähnlich beginnende Klassen sind keine Breite', () => {
    expect(vorgabeBreite('flex-1 min-w-[240px]')).toBe('w-full')
    expect(vorgabeBreite('max-w-xs')).toBe('w-full')
    expect(vorgabeBreite('basis-40')).toBe('w-full')
    expect(vorgabeBreite('whitespace-nowrap wrap-break-word')).toBe('w-full')
  })
})
