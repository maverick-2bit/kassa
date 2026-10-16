import { describe, expect, it } from 'vitest'
import { dateinameTeil } from './dateiSpeichern'

describe('dateinameTeil: Firmenname → Teil eines Dateinamens', () => {
  it('Kleinbuchstaben, Bindestriche statt Leerzeichen und Sonderzeichen', () => {
    expect(dateinameTeil('smarte events OG')).toBe('smarte-events-og')
    expect(dateinameTeil('2bit e.U.')).toBe('2bit-e-u')
    expect(dateinameTeil('  Verein  „Sonnenschein"  ')).toBe('verein-sonnenschein')
  })

  it('Umlaute und ß werden zu einfachen Buchstaben', () => {
    expect(dateinameTeil('Café Müller & Söhne')).toBe('cafe-muller-sohne')
    expect(dateinameTeil('Straße')).toBe('strasse')
  })

  it('ohne brauchbare Zeichen bleibt „kassa"', () => {
    expect(dateinameTeil('')).toBe('kassa')
    expect(dateinameTeil('***')).toBe('kassa')
  })
})
