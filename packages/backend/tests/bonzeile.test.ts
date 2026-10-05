import { describe, it, expect } from 'vitest'
import { baueBonierbon, baueErledigtBon, bonZeile, istStornoZeile } from '../src/services/bonierdrucker.service.js'

describe('Bonzeile: Menge + Name, Storno vorne gekennzeichnet', () => {
  it('normale Position: "5x Almdudler"', () => {
    expect(bonZeile(5, 'Almdudler')).toBe('5x Almdudler')
  })

  it('Storno-Bon (Flag): "STORNO: 5x Almdudler"', () => {
    expect(bonZeile(5, 'Almdudler', true)).toBe('STORNO: 5x Almdudler')
  })

  it('Storno-Position vom KDS-Bildschirm ("✕ STORNO: …"): Fremdzeichen weg, Menge hinter STORNO', () => {
    const z = bonZeile(5, '✕ STORNO: Almdudler')
    expect(z).toBe('STORNO: 5x Almdudler')
    expect(z).not.toMatch(/[^\x20-\x7e]/)         // reines ASCII, nichts Druckerfremdes
  })

  it('Storno-Bon UND Storno-Position: STORNO nur einmal', () => {
    expect(bonZeile(2, '✕ STORNO: Bier', true)).toBe('STORNO: 2x Bier')
  })

  it('andere Zeichen vor STORNO (✗, ×) und Umlaute im Namen bleiben richtig', () => {
    expect(bonZeile(1, '✗ STORNO: Weißbier')).toBe('STORNO: 1x Weißbier')
    expect(bonZeile(1, '× STORNO: Käsespätzle')).toBe('STORNO: 1x Käsespätzle')
  })

  it('istStornoZeile erkennt nur den Präfix, nicht einen Namen, der "Storno" enthält', () => {
    expect(istStornoZeile('✕ STORNO: Cola')).toBe(true)
    expect(istStornoZeile('Cola')).toBe(false)
    expect(istStornoZeile('Stornoschnitzel')).toBe(false)
  })
})

describe('Gedruckte Bytes: Storno-Zeile ohne Fremdzeichen', () => {
  const text = (b: Buffer) => b.toString('latin1')
  const ohneHochkomma = (b: Buffer) => !b.includes(Buffer.from([0xe2, 0x9c, 0x95]))   // UTF-8 von "✕"

  it('Erledigt-Bon eines Storno-Bons vom KDS: "STORNO: 5x Almdudler", Überschrift STORNO ERLEDIGT, kein ✕', () => {
    const bon = baueErledigtBon({
      tischNummer: '5', kellner: 'Anna',
      fertig: [{ menge: 5, bezeichnung: '✕ STORNO: Almdudler', preisLabel: '' }],
      rest: [],
    })
    expect(text(bon)).toContain('STORNO: 5x Almdudler')
    expect(text(bon)).toContain('STORNO ERLEDIGT')
    expect(text(bon)).not.toContain('BESTELLUNG KOMPLETT')
    expect(text(bon)).not.toMatch(/5x\s*STORNO/)
    expect(ohneHochkomma(bon)).toBe(true)
  })

  it('Erledigt-Bon einer normalen Bestellung bleibt unverändert', () => {
    const bon = baueErledigtBon({
      tischNummer: '5', kellner: 'Anna',
      fertig: [{ menge: 2, bezeichnung: 'Bier', preisLabel: '' }],
      rest: [],
    })
    expect(text(bon)).toContain('2x Bier')
    expect(text(bon)).toContain('BESTELLUNG KOMPLETT')
  })

  it('Nachdruck eines KDS-Storno-Bons (Bonierbon ohne Storno-Flag, Position mit Präfix): STORNO: 5x …', () => {
    const bon = baueBonierbon('5', 'Anna', [{ menge: 5, bezeichnung: '✕ STORNO: Almdudler', preisLabel: '' }])
    expect(text(bon)).toContain('STORNO: 5x Almdudler')
    expect(ohneHochkomma(bon)).toBe(true)
  })

  it('Storno-Bon direkt gedruckt (Flag): "STORNO: 5x Almdudler" unter dem STORNO-Kopf', () => {
    const bon = baueBonierbon('5', 'Anna', [{ menge: 5, bezeichnung: 'Almdudler', preisLabel: '' }], true)
    expect(text(bon)).toContain('*** STORNO ***')
    expect(text(bon)).toContain('STORNO: 5x Almdudler')
    expect(text(bon)).toContain('NICHT ZUBEREITEN')
  })
})