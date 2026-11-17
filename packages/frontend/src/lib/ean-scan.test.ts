import { describe, it, expect } from 'vitest'
import { findeNachEan, ScanPuffer } from './ean-scan'

const tippe = (p: ScanPuffer, text: string, start: number, abstand: number): string | null => {
  let ergebnis: string | null = null
  ;[...text.split(''), 'Enter'].forEach((k, i) => { ergebnis = p.taste(k, start + i * abstand) })
  return ergebnis
}

describe('ScanPuffer', () => {
  it('liefert die EAN, wenn ein Scanner schnell Ziffern + Enter schickt', () => {
    expect(tippe(new ScanPuffer(), '9002490100070', 1000, 10)).toBe('9002490100070')
  })

  it('ignoriert langsam getippte Ziffern (Mensch an der Tastatur) und ungültige Prüfziffern', () => {
    expect(tippe(new ScanPuffer(), '9002490100070', 1000, 300)).toBeNull()
    expect(tippe(new ScanPuffer(), '9002490100071', 1000, 10)).toBeNull()
  })

  it('beginnt nach einer Pause neu — alte Ziffern hängen nicht vor dem nächsten Scan', () => {
    const p = new ScanPuffer()
    p.taste('4', 0); p.taste('2', 5)
    expect(tippe(p, '96385074', 5000, 8)).toBe('96385074')
  })

  it('andere Tasten zwischendurch verwerfen den Puffer', () => {
    const p = new ScanPuffer()
    ;['9', '6', '3', 'a', '8', '5', '0', '7', '4'].forEach((k, i) => p.taste(k, i * 5))
    expect(p.taste('Enter', 50)).toBeNull()
  })
})

describe('findeNachEan', () => {
  const artikel = [
    { id: 'milch', ean: '9002490100070' },
    { id: 'usa', ean: '0012345678905' },
    { id: 'ohne', ean: null },
  ]
  it('findet über den GTIN-14-Schlüssel (UPC-A 12-stellig gescannt, 13-stellig erfasst)', () => {
    expect(findeNachEan(artikel, '9002490100070')?.id).toBe('milch')
    expect(findeNachEan(artikel, '012345678905')?.id).toBe('usa')
  })
  it('ungültige oder unbekannte EAN → undefined', () => {
    expect(findeNachEan(artikel, '9002490100071')).toBeUndefined()
    expect(findeNachEan(artikel, '4006381333931')).toBeUndefined()
  })
})
