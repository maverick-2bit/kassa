import { describe, expect, it } from 'vitest'
import { MASSE, SN_ZEILENHOEHE, paginiere, positionsHoehe, seriennummernText, type SeitenZeile } from './sammelrechnung-seiten'

const kopf = (): SeitenZeile => ({ art: 'kopf', hoehe: MASSE.kopf })
const pos = (cent: number): SeitenZeile => ({ art: 'pos', hoehe: MASSE.position, betragCent: cent })
const leer = (): SeitenZeile => ({ art: 'leer', hoehe: MASSE.leer })

/** Ein Lieferschein: Hinweiszeile + n Positionen zu je 100 Cent */
const lieferschein = (n: number, mitAbstand: boolean): SeitenZeile[] => [
  ...(mitAbstand ? [leer(), leer()] : []),
  kopf(),
  ...Array.from({ length: n }, () => pos(100)),
]

const KAP = { erste: 100, folge: 200, abschluss: 40 }

describe('Sammelrechnung: Seitenumbruch', () => {
  it('kurze Rechnung: eine Seite, kein Übertrag, kein Zwischenstand', () => {
    const seiten = paginiere([...lieferschein(2, false), ...lieferschein(1, true)], KAP)
    expect(seiten).toHaveLength(1)
    expect(seiten[0]).toMatchObject({ letzte: true, uebertragVor: null, zwischensummeNach: null })
    expect(seiten[0]!.zeilen).toHaveLength(1 + 2 + 2 + 1 + 1)
  })

  it('lange Rechnung: Zwischensumme am Seitenende = Übertrag oben auf der Folgeseite; nichts geht verloren', () => {
    const zeilen = [...lieferschein(8, false), ...lieferschein(8, true), ...lieferschein(8, true)]
    const seiten = paginiere(zeilen, KAP)
    expect(seiten.length).toBeGreaterThan(1)

    for (let k = 0; k < seiten.length - 1; k++) {
      expect(seiten[k]!.letzte).toBe(false)
      expect(seiten[k]!.zwischensummeNach).not.toBeNull()
      expect(seiten[k + 1]!.uebertragVor).toBe(seiten[k]!.zwischensummeNach)
    }
    expect(seiten[0]!.uebertragVor).toBeNull()
    expect(seiten[seiten.length - 1]!.letzte).toBe(true)
    expect(seiten[seiten.length - 1]!.zwischensummeNach).toBeNull()

    // Summe aller Positionen = 24 × 100; alle Positionszeilen sind auf genau einer Seite
    const gesamt = seiten.flatMap(s => s.zeilen).reduce((s, z) => s + (z.betragCent ?? 0), 0)
    expect(gesamt).toBe(2400)
    expect(seiten.flatMap(s => s.zeilen).filter(z => z.art === 'pos')).toHaveLength(24)
    expect(seiten.flatMap(s => s.zeilen).filter(z => z.art === 'kopf')).toHaveLength(3)
  })

  it('keine Seite überschreitet ihre Kapazität (inkl. Übertrag/Zwischensumme bzw. Abschluss)', () => {
    const zeilen = [...lieferschein(15, false), ...lieferschein(12, true), ...lieferschein(9, true)]
    const seiten = paginiere(zeilen, KAP)
    seiten.forEach((s, k) => {
      const verfuegbar = k === 0 ? KAP.erste : KAP.folge
      const belegt = s.zeilen.reduce((a, z) => a + z.hoehe, 0)
        + (k > 0 ? MASSE.uebertrag : 0)
        + (s.letzte ? KAP.abschluss : MASSE.zwischensumme)
      expect(belegt).toBeLessThanOrEqual(verfuegbar)
    })
  })

  it('eine Hinweiszeile steht nie allein am Seitenende, Leerzeilen nie am Seitenanfang', () => {
    for (let n = 1; n <= 30; n++) {
      const seiten = paginiere([...lieferschein(n, false), ...lieferschein(n, true), ...lieferschein(n, true)], KAP)
      seiten.forEach((s, k) => {
        if (!s.letzte) expect(s.zeilen[s.zeilen.length - 1]!.art).toBe('pos')
        if (s.zeilen.length > 0) expect(s.zeilen[0]!.art).not.toBe('leer')
        void k
      })
    }
  })

  it('passt die Tabelle, aber nicht der Abschlussblock, kommt dieser auf eine eigene Seite mit Übertrag', () => {
    // Tabelle füllt Seite 1 fast ganz: Rest + Abschluss passt nicht mehr
    const zeilen = [kopf(), ...Array.from({ length: 11 }, () => pos(250))]   // 9 + 88 = 97 mm von 100
    const seiten = paginiere(zeilen, KAP)
    expect(seiten.length).toBeGreaterThan(1)
    const letzte = seiten[seiten.length - 1]!
    expect(letzte.letzte).toBe(true)
    expect(letzte.uebertragVor).toBe(11 * 250 - letzte.zeilen.reduce((s, z) => s + (z.betragCent ?? 0), 0))
  })

  it('Positionszeilen wachsen mit langen Bezeichnungen (höchstens drei Zeilen)', () => {
    expect(positionsHoehe('Support')).toBe(MASSE.position)
    expect(positionsHoehe('x'.repeat(37))).toBe(MASSE.position + MASSE.zusatzZeile)
    expect(positionsHoehe('x'.repeat(500))).toBe(MASSE.position + 2 * MASSE.zusatzZeile)
  })

  it('Seriennummern machen die Positionszeile höher (kleine Schrift unter der Bezeichnung)', () => {
    expect(positionsHoehe('Kassa', [])).toBe(MASSE.position)
    expect(positionsHoehe('Kassa', ['SN-1'])).toBeCloseTo(MASSE.position + SN_ZEILENHOEHE)
    // 10 Seriennummern à 14 Zeichen → mehrere Zeilen
    const viele = Array.from({ length: 10 }, (_, i) => `SN-2026-00${i}-X`)
    expect(positionsHoehe('Kassa', viele)).toBeGreaterThan(MASSE.position + 2 * SN_ZEILENHOEHE)
    expect(seriennummernText(['A', 'B'])).toBe('SN: A, B')
    expect(seriennummernText(undefined)).toBe('')
  })

  it('leere Rechnung und Riesenzeile führen nicht in eine Endlosschleife', () => {
    expect(paginiere([], KAP)).toHaveLength(1)
    const riesig = paginiere([{ art: 'pos', hoehe: 999, betragCent: 5 }, pos(7)], KAP)
    expect(riesig.flatMap(s => s.zeilen)).toHaveLength(2)
  })
})
