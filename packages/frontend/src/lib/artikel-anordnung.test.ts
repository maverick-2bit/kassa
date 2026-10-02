import { describe, it, expect } from 'vitest'
import { loeseAnordnungAuf, type KassenAnordnungEintrag } from '@kassa/shared'
import {
  anordnungSchluessel,
  anordnungVon,
  anzahlPlatziert,
  anzahlSlotZellen,
  blendeAus,
  entferneLuecken,
  hatLuecken,
  istGleich,
  kannVersetzen,
  MAX_SLOT,
  platziere,
  setzeAufSlot,
  slotVon,
  unbekannteZeilenBehalten,
  versetze,
  zellPosition,
  zuKassenEintraegen,
  zuStandardEintraegen,
  type Anordnung,
} from './artikel-anordnung'

const z = (slots: (string | null)[], ausgeblendet: string[] = []): Anordnung => ({ slots, ausgeblendet })

describe('anordnungVon: effektive Anordnung als Editor-Zustand', () => {
  const art = (id: string, rasterPosition: number | null = null) => ({ id, bezeichnung: id, reihenfolge: 0, rasterPosition })

  it('übernimmt Slots (Lücken = null) und Ablage aus loeseAnordnungAuf', () => {
    const a = loeseAnordnungAuf([art('A', 1), art('B', 3), art('C')], [
      { artikelId: 'A', position: 2, ausgeblendet: false },
      { artikelId: 'B', position: null, ausgeblendet: true },
    ])
    expect(anordnungVon(a)).toEqual({ slots: [null, 'A', 'C'], ausgeblendet: ['B'] })
  })

  it('Standard-Layout (keine eigene Anordnung): genau das, was die Kasse zeigt — auch die angehängten Artikel', () => {
    const a = loeseAnordnungAuf([art('A', 1), art('B', 3), art('Neu')], undefined)
    expect(anordnungVon(a)).toEqual({ slots: ['A', null, 'B', 'Neu'], ausgeblendet: [] })
  })

  it('Roundtrip: speichern und neu auflösen ergibt dieselbe Anordnung (erster Speichervorgang hält fest, was man sieht)', () => {
    const artikel = [art('A', 1), art('B', 4), art('C'), art('D')]
    const start = anordnungVon(loeseAnordnungAuf(artikel, undefined))
    const geaendert = blendeAus(versetze(start, 'A', 1), 'D')
    const gespeichert: KassenAnordnungEintrag[] = zuKassenEintraegen(geaendert)
    const neu = anordnungVon(loeseAnordnungAuf(artikel, gespeichert))
    expect(neu.slots).toEqual(geaendert.slots)
    expect([...neu.ausgeblendet].sort()).toEqual([...geaendert.ausgeblendet].sort())
    // und ohne jede Änderung: der erste Speichervorgang friert den Standard ein
    const eingefroren = anordnungVon(loeseAnordnungAuf(artikel, zuKassenEintraegen(start)))
    expect(eingefroren).toEqual(start)
  })
})

describe('setzeAufSlot: ziehen und tauschen', () => {
  it('freie Zelle: der Artikel zieht um, sein alter Platz wird leer, hintere leere Felder entfallen', () => {
    expect(setzeAufSlot(z(['A', 'B']), 'A', 4)).toEqual(z([null, 'B', null, 'A']))
    expect(setzeAufSlot(z([null, null, 'A']), 'A', 1)).toEqual(z(['A']))
  })

  it('belegte Zelle: die beiden Artikel tauschen', () => {
    expect(setzeAufSlot(z(['A', 'B', 'C']), 'A', 3)).toEqual(z(['C', 'B', 'A']))
    expect(setzeAufSlot(z(['A', null, 'C']), 'C', 1)).toEqual(z(['C', null, 'A']))
  })

  it('weit hinter dem Ende: füllt mit leeren Feldern auf', () => {
    expect(setzeAufSlot(z(['A']), 'A', 5)).toEqual(z([null, null, null, null, 'A']))
  })

  it('derselbe Platz, Slot außerhalb 1..MAX_SLOT, Bruchzahl, unbekannter Artikel: unverändert (gleiche Referenz)', () => {
    const a = z(['A', 'B'], ['X'])
    expect(setzeAufSlot(a, 'A', 1)).toBe(a)
    expect(setzeAufSlot(a, 'A', 0)).toBe(a)
    expect(setzeAufSlot(a, 'A', -2)).toBe(a)
    expect(setzeAufSlot(a, 'A', MAX_SLOT + 1)).toBe(a)
    expect(setzeAufSlot(a, 'A', 1.5)).toBe(a)
    expect(setzeAufSlot(a, 'Gibt-es-nicht', 3)).toBe(a)
    expect(setzeAufSlot(a, 'A', MAX_SLOT)).not.toBe(a)
  })

  it('Artikel aus der Ablage: nur auf FREIE Zellen — auf eine belegte passiert nichts', () => {
    const a = z(['A', null, 'C'], ['X'])
    expect(setzeAufSlot(a, 'X', 2)).toEqual(z(['A', 'X', 'C']))
    expect(setzeAufSlot(a, 'X', 5)).toEqual(z(['A', null, 'C', null, 'X']))
    expect(setzeAufSlot(a, 'X', 1)).toBe(a)
    expect(setzeAufSlot(a, 'X', 3)).toBe(a)
  })

  it('verändert den Eingabezustand nicht', () => {
    const a = z(['A', 'B'], ['X'])
    const kopie = JSON.parse(JSON.stringify(a))
    setzeAufSlot(a, 'A', 2)
    blendeAus(a, 'A')
    platziere(a, 'X')
    entferneLuecken(a)
    expect(a).toEqual(kopie)
  })
})

describe('versetze / kannVersetzen: ← → ↑ ↓', () => {
  const spalten = 4
  it('← → um eine Zelle, ↑ ↓ um eine Zeile (= Spaltenzahl Slots)', () => {
    const a = z([null, null, null, null, null, 'A'])           // Slot 6 = Zeile 2, Spalte 2
    expect(slotVon(versetze(a, 'A', -1), 'A')).toBe(5)
    expect(slotVon(versetze(a, 'A', +1), 'A')).toBe(7)
    expect(slotVon(versetze(a, 'A', -spalten), 'A')).toBe(2)   // Zeile 1, gleiche Spalte
    expect(slotVon(versetze(a, 'A', +spalten), 'A')).toBe(10)
  })

  it('am Rand gesperrt: Slot 1 nicht nach links, erste Zeile nicht nach oben, MAX_SLOT nicht weiter', () => {
    const a = z(['A', 'B', 'C', 'D', 'E'])
    expect(kannVersetzen(a, 'A', -1)).toBe(false)
    expect(kannVersetzen(a, 'C', -spalten)).toBe(false)
    expect(kannVersetzen(a, 'E', -spalten)).toBe(true)         // Slot 5 → 1
    expect(versetze(a, 'A', -1)).toBe(a)
    const ganzHinten = setzeAufSlot(a, 'A', MAX_SLOT)
    expect(kannVersetzen(ganzHinten, 'A', +1)).toBe(false)
    expect(kannVersetzen(ganzHinten, 'A', +spalten)).toBe(false)
    expect(versetze(ganzHinten, 'A', +1)).toBe(ganzHinten)
  })

  it('ein Artikel in der Ablage oder unbekannt lässt sich nicht versetzen', () => {
    const a = z(['A'], ['X'])
    expect(kannVersetzen(a, 'X', 1)).toBe(false)
    expect(versetze(a, 'X', 1)).toBe(a)
    expect(kannVersetzen(a, 'Q', 1)).toBe(false)
    expect(versetze(a, 'A', 0)).toBe(a)
  })

  it('nach rechts über das Ende hinaus legt eine neue Zelle an; auf einen Nachbarn: tauschen', () => {
    expect(versetze(z(['A']), 'A', +1)).toEqual(z([null, 'A']))
    expect(versetze(z(['A', 'B']), 'A', +1)).toEqual(z(['B', 'A']))
  })
})

describe('blendeAus / platziere: die Ablage', () => {
  it('Ausblenden lässt eine Lücke, hängt den Artikel an die Ablage an und kappt leere Felder am Ende', () => {
    expect(blendeAus(z(['A', 'B', 'C']), 'B')).toEqual(z(['A', null, 'C'], ['B']))
    expect(blendeAus(z(['A', 'B', 'C']), 'C')).toEqual(z(['A', 'B'], ['C']))
    expect(blendeAus(z([null, 'A']), 'A')).toEqual(z([], ['A']))
  })

  it('unbekannter oder schon ausgeblendeter Artikel: unverändert', () => {
    const a = z(['A'], ['X'])
    expect(blendeAus(a, 'X')).toBe(a)
    expect(blendeAus(a, 'Q')).toBe(a)
  })

  it('Platzieren setzt den Artikel in die ERSTE freie Zelle, sonst hinten dran', () => {
    expect(platziere(z(['A', null, 'C', null, 'E'], ['X']), 'X')).toEqual(z(['A', 'X', 'C', null, 'E']))
    expect(platziere(z(['A', 'B'], ['X']), 'X')).toEqual(z(['A', 'B', 'X']))
    expect(platziere(z([], ['X', 'Y']), 'X')).toEqual(z(['X'], ['Y']))
    expect(platziere(z([null, 'B'], ['X']), 'X')).toEqual(z(['X', 'B']))
  })

  it('Platzieren ohne Platz (Raster voll) oder ohne Ablage-Eintrag: unverändert', () => {
    const voll = z(Array.from({ length: MAX_SLOT }, (_, i) => `A${i}`), ['X'])
    expect(platziere(voll, 'X')).toBe(voll)
    const a = z(['A'], ['X'])
    expect(platziere(a, 'A')).toBe(a)
    expect(platziere(a, 'Q')).toBe(a)
  })

  it('aus und wieder ein: ohne Lücken dahinter landet der Artikel wieder an seinem Platz', () => {
    const a = z(['A', 'B', 'C'])
    expect(platziere(blendeAus(a, 'B'), 'B')).toEqual(a)
  })
})

describe('entferneLuecken: lückenlos verdichten', () => {
  it('schiebt die Artikel in Reihenfolge zusammen, die Ablage bleibt', () => {
    expect(entferneLuecken(z([null, 'A', null, null, 'B', 'C'], ['X']))).toEqual(z(['A', 'B', 'C'], ['X']))
  })

  it('ohne Lücken: gleiche Referenz', () => {
    const a = z(['A', 'B'])
    expect(entferneLuecken(a)).toBe(a)
    expect(entferneLuecken(z([]))).toEqual(z([]))
  })

  it('hatLuecken / anzahlPlatziert', () => {
    expect(hatLuecken(z(['A', null, 'B']))).toBe(true)
    expect(hatLuecken(z(['A', 'B']))).toBe(false)
    expect(anzahlPlatziert(z([null, 'A', null, 'B']))).toBe(2)
  })
})

describe('Vergleich: dirty-Erkennung', () => {
  it('Reihenfolge der Ablage zählt nicht, die Platzierung schon', () => {
    expect(istGleich(z(['A'], ['X', 'Y']), z(['A'], ['Y', 'X']))).toBe(true)
    expect(istGleich(z(['A', 'B']), z(['B', 'A']))).toBe(false)
    expect(istGleich(z(['A'], ['X']), z(['A'], []))).toBe(false)
    expect(anordnungSchluessel(z(['A', null, 'B']))).not.toBe(anordnungSchluessel(z(['A', 'B'])))
  })
})

describe('Raster-Geometrie', () => {
  it('Slot-Zellen: Belegtes + Rest der Zeile + MINDESTENS eine ganz leere Zeile', () => {
    // 4 Spalten, 6 Artikel → Zeile 1+2 (Rest 2 Zellen) + eine leere Zeile = 12 Zellen
    expect(anzahlSlotZellen(6, 0, 4)).toBe(12)
    // genau gefüllte Zeilen: 8 Artikel → 8 + leere Zeile 4
    expect(anzahlSlotZellen(8, 0, 4)).toBe(12)
    // leeres Raster: eine leere Zeile
    expect(anzahlSlotZellen(0, 0, 3)).toBe(3)
  })

  it('Untergruppen-Kacheln davor verschieben den Zeilenumbruch, sind aber keine Slot-Zellen', () => {
    // 2 Kacheln + 0 Artikel bei 3 Spalten: 1 Zeile belegt (2 Kacheln) + 1 leere = 6 Zellen − 2 Kacheln = 4 Slot-Zellen
    expect(anzahlSlotZellen(0, 2, 3)).toBe(4)
    // 2 Kacheln + 1 Artikel: Zeile voll (3) → + leere Zeile = 6 Zellen − 2 = 4
    expect(anzahlSlotZellen(1, 2, 3)).toBe(4)
    // 2 Kacheln + 2 Artikel: 4 Zellen → 2 Zeilen + leere Zeile = 9 − 2 = 7
    expect(anzahlSlotZellen(2, 2, 3)).toBe(7)
  })

  it('nie mehr als MAX_SLOT Zellen', () => {
    expect(anzahlSlotZellen(MAX_SLOT, 0, 6)).toBe(MAX_SLOT)
    expect(anzahlSlotZellen(MAX_SLOT, 5, 2)).toBe(MAX_SLOT)
  })

  it('Zellposition (1-basiert) im Raster', () => {
    expect(zellPosition(0, 4)).toEqual({ zeile: 1, spalte: 1 })
    expect(zellPosition(3, 4)).toEqual({ zeile: 1, spalte: 4 })
    expect(zellPosition(4, 4)).toEqual({ zeile: 2, spalte: 1 })
    expect(zellPosition(10, 3)).toEqual({ zeile: 4, spalte: 2 })
  })
})

describe('Speichern: Einträge für die API', () => {
  it('Kasse: platziert mit Slot (1-basiert, Lücken zählen mit), Ablage ausgeblendet ohne Position', () => {
    expect(zuKassenEintraegen(z([null, 'A', null, 'B'], ['X', 'Y']))).toEqual([
      { artikelId: 'A', position: 2, ausgeblendet: false },
      { artikelId: 'B', position: 4, ausgeblendet: false },
      { artikelId: 'X', position: null, ausgeblendet: true },
      { artikelId: 'Y', position: null, ausgeblendet: true },
    ])
    expect(zuKassenEintraegen(z([]))).toEqual([])
  })

  it('Standard: Slot je platziertem Artikel, Ablage → position null', () => {
    expect(zuStandardEintraegen(z(['A', null, 'B'], ['X']))).toEqual([
      { artikelId: 'A', position: 1 },
      { artikelId: 'B', position: 3 },
      { artikelId: 'X', position: null },
    ])
  })

  it('Einträge sind nie doppelt und für das Schema gültig (Positionen eindeutig)', () => {
    const e = zuKassenEintraegen(z(['A', 'B', null, 'C'], ['X']))
    expect(new Set(e.map(x => x.artikelId)).size).toBe(e.length)
    const positionen = e.flatMap(x => (x.position === null ? [] : [x.position]))
    expect(new Set(positionen).size).toBe(positionen.length)
  })
})

describe('unbekannteZeilenBehalten: deaktivierte Artikel behalten ihren Platz', () => {
  const gespeichert = [
    { artikelId: 'A', position: 1, ausgeblendet: false },
    { artikelId: 'Alt', position: 2, ausgeblendet: false },       // deaktiviert, unbekannt
    { artikelId: 'AltVersteckt', position: null, ausgeblendet: true },
    { artikelId: 'AltKonflikt', position: 5, ausgeblendet: false },
  ]
  const bekannt = new Set(['A', 'B'])

  it('bleibt erhalten, solange der Slot frei ist; kollidiert er mit einem neu belegten Slot, entfällt die Zeile', () => {
    const neu = zuKassenEintraegen(z(['A', null, null, null, 'B']))     // B belegt Slot 5
    const behalten = unbekannteZeilenBehalten(gespeichert, bekannt, neu)
    expect(behalten.map(e => e.artikelId)).toEqual(['Alt', 'AltVersteckt'])
  })

  it('gleiche Slots unter den unbekannten Zeilen werden nicht doppelt vergeben', () => {
    const doppelt = [
      { artikelId: 'P', position: 3, ausgeblendet: false },
      { artikelId: 'Q', position: 3, ausgeblendet: false },
    ]
    expect(unbekannteZeilenBehalten(doppelt, new Set(), []).map(e => e.artikelId)).toEqual(['P'])
  })

  it('bekannte Artikel werden nie durchgereicht (der Editor schreibt sie neu)', () => {
    expect(unbekannteZeilenBehalten(gespeichert, new Set(['A', 'Alt', 'AltVersteckt', 'AltKonflikt']), [])).toEqual([])
  })
})
