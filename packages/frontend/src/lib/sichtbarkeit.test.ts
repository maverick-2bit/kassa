import { describe, it, expect } from 'vitest'
import { erweitereSichtbarkeit } from './kategorie-baum'
import { alleAktiv, istSichtbar, sichtbarkeitsZustaende, toggle, waehleNur, zaehlung } from './sichtbarkeit'
import { ALLE_IDS, asselloBaum, BAUM_REIHENFOLGE, kat } from './testdaten-kategorien'

const menge = asselloBaum()
const zustandVon = (liste: string[], id: string) => sichtbarkeitsZustaende(menge, liste).get(id)
const ohne = (...weg: string[]) => BAUM_REIHENFOLGE.filter(id => !weg.includes(id))

describe('Sichtbarkeit je Kasse: leere Liste = alle', () => {
  it('bei leerer Liste sind ALLE Gruppen „an" und sichtbar', () => {
    expect(alleAktiv([])).toBe(true)
    const z = sichtbarkeitsZustaende(menge, [])
    expect([...z.values()].every(v => v === 'an')).toBe(true)
    expect(z.size).toBe(ALLE_IDS.length)
    expect(istSichtbar(menge, [], 'ev-alko')).toBe(true)
    expect(zaehlung(menge, [])).toEqual({ sichtbar: 14, gesamt: 14 })
  })

  it('aus „alle" eine Gruppe abwählen → explizite Liste aller außer dem Teilbaum (die Elterngruppe wird teilweise)', () => {
    const r = toggle(menge, [], 'kel-alko')
    expect(r.blockiert).toBeNull()
    // kel-alko ist ein Blatt; seine Elterngruppe „Kellner Getränke" wird „teilweise" und steht NICHT mehr in der Liste
    expect(r.liste).toEqual(ohne('kel-alko', 'kel'))
    expect(zustandVon(r.liste, 'kel-alko')).toBe('aus')
    expect(zustandVon(r.liste, 'kel')).toBe('teilweise')
    expect(zustandVon(r.liste, 'kel-bier')).toBe('an')
    // …und die Kasse (erweitereSichtbarkeit) zeigt genau das: Kellner Getränke bleibt als Zugang sichtbar
    const kasse = new Set(erweitereSichtbarkeit(menge, r.liste))
    expect(kasse.has('kel')).toBe(true)
    expect(kasse.has('kel-bier')).toBe(true)
    expect(kasse.has('kel-alko')).toBe(false)
    expect(zaehlung(menge, r.liste)).toEqual({ sichtbar: 13, gesamt: 14 })
  })

  it('aus „alle" eine Hauptgruppe abwählen schaltet den ganzen Teilbaum aus', () => {
    const r = toggle(menge, [], 'atr')
    expect(r.liste).toEqual(ohne('atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein'))
    for (const id of ['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']) expect(zustandVon(r.liste, id)).toBe('aus')
    expect(zustandVon(r.liste, 'kel')).toBe('an')
    // gleichnamige Gruppen in anderen Teilbäumen bleiben unberührt
    expect(zustandVon(r.liste, 'kel-alko')).toBe('an')
    expect(zustandVon(r.liste, 'ev-alko')).toBe('an')
  })

  it('gleichnamige Gruppen sind unabhängig: nur EINE „Alkoholfrei" abwählen', () => {
    const r = toggle(menge, [], 'ev-alko')
    expect(zustandVon(r.liste, 'ev-alko')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('an')
    expect(zustandVon(r.liste, 'kel-alko')).toBe('an')
    expect(zustandVon(r.liste, 'ev-pakete')).toBe('teilweise')   // Kaffee ist noch an
    expect(zustandVon(r.liste, 'ev')).toBe('teilweise')
  })

  it('wieder alle Gruppen an → [] (alle sichtbar) wird gespeichert', () => {
    const ohneGrillen = toggle(menge, [], 'grillen').liste
    expect(ohneGrillen).toEqual(ohne('grillen'))
    expect(toggle(menge, ohneGrillen, 'grillen').liste).toEqual([])
    // auch über den Halbzustand: Kellner-Alkoholfrei ab, Elterngruppe (teilweise) anklicken → alles wieder an
    const teil = toggle(menge, [], 'kel-alko').liste
    expect(toggle(menge, teil, 'kel').liste).toEqual([])
  })

  it('die LETZTE sichtbare Gruppe lässt sich nicht abwählen', () => {
    const nurGrillen = ['grillen']
    const r = toggle(menge, nurGrillen, 'grillen')
    expect(r.blockiert).toBe('letzte')
    expect(r.liste).toEqual(['grillen'])
    // auch nicht über einen Teilbaum, der die letzte Auswahl enthält
    const nurAtr = waehleNur(menge, 'atr')
    expect(toggle(menge, nurAtr, 'atr').blockiert).toBe('letzte')
    // und nicht aus „alle" bei nur einer Gruppe
    expect(toggle([kat('x', 'X', null, 0)], [], 'x').blockiert).toBe('letzte')
  })
})

describe('Teilbaum-Schalter und Halbzustände', () => {
  it('Eltern einschalten schaltet alle Untergruppen mit ein', () => {
    const r = toggle(menge, ['grillen'], 'atr')
    expect(r.liste).toEqual(['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein', 'grillen'])
    expect(zustandVon(r.liste, 'atr-limo')).toBe('an')
  })

  it('Eltern ausschalten schaltet alle Untergruppen mit aus', () => {
    const start = toggle(menge, ['grillen'], 'atr').liste
    const r = toggle(menge, start, 'atr')
    expect(r.liste).toEqual(['grillen'])
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
  })

  it('einzelne Untergruppe ausschalten unter eingeschalteter Elterngruppe → Eltern „teilweise", Geschwister bleiben an', () => {
    const r = toggle(menge, [], 'atr-saft')
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-limo')).toBe('an')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('teilweise')
    expect(zustandVon(r.liste, 'atr')).toBe('teilweise')
    expect(istSichtbar(menge, r.liste, 'atr')).toBe(true)       // Zugang bleibt sichtbar
    expect(istSichtbar(menge, r.liste, 'atr-saft')).toBe(false)
  })

  it('einzelne Untergruppe unter ausgeschalteter Elterngruppe einschalten → Eltern „teilweise" (Zugang), nur diese an', () => {
    const r = toggle(menge, ['grillen'], 'atr-wein')
    expect(r.liste).toEqual(['atr-wein', 'grillen'])
    expect(zustandVon(r.liste, 'atr-wein')).toBe('an')
    expect(zustandVon(r.liste, 'atr')).toBe('teilweise')
    expect(zustandVon(r.liste, 'atr-bier')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('aus')
  })

  it('sind danach alle Untergruppen an, ist die Elterngruppe wieder „an" (Hochziehen)', () => {
    let liste = ['grillen']
    for (const id of ['atr-alko', 'atr-bier', 'atr-wein']) liste = toggle(menge, liste, id).liste
    expect(zustandVon(liste, 'atr')).toBe('an')
    expect(liste).toEqual(['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein', 'grillen'])
  })

  it('eine Gruppe, die nur wegen einer eingeschalteten Untergruppe sichtbar ist, schaltet beim Abwählen den Rest aus', () => {
    const start = toggle(menge, ['grillen'], 'atr-wein').liste        // atr = teilweise
    const r = toggle(menge, start, 'atr-wein')                        // Wein wieder aus
    expect(r.liste).toEqual(['grillen'])
    expect(zustandVon(r.liste, 'atr')).toBe('aus')
  })

  it('einzige Untergruppe unter eingeschalteter Elterngruppe: die Elterngruppe geht mit aus (nicht darstellbar als „an ohne Untergruppe")', () => {
    const m = [kat('p', 'P', null, 0), kat('c', 'C', 'p', 0), kat('q', 'Q', null, 1)]
    const r = toggle(m, [], 'c')
    expect(r.liste).toEqual(['q'])
    expect(sichtbarkeitsZustaende(m, r.liste).get('p')).toBe('aus')
  })
})

describe('gespeicherte Listen aus älteren Ständen und Randfälle', () => {
  it('Liste nur mit der Elterngruppe: Untergruppen gelten als an (wie die Kasse es auswertet)', () => {
    expect(zustandVon(['kel'], 'kel-alko')).toBe('an')
    expect(zustandVon(['kel'], 'kel-bier')).toBe('an')
    expect(zustandVon(['kel'], 'atr')).toBe('aus')
  })

  it('Liste mit allen Untergruppen, aber ohne die Elterngruppe: Eltern „an" (alle Untergruppen an)', () => {
    expect(zustandVon(['kel-alko', 'kel-bier'], 'kel')).toBe('an')
  })

  it('unbekannte IDs werden ignoriert; ohne bekannte Gruppe ist nichts sichtbar (wie an der Kasse)', () => {
    expect(zustandVon(['gibt-es-nicht'], 'atr')).toBe('aus')
    expect(istSichtbar(menge, ['gibt-es-nicht'], 'atr')).toBe(false)
    expect(toggle(menge, ['grillen'], 'gibt-es-nicht')).toEqual({ liste: ['grillen'], blockiert: null })
  })

  it('waehleNur („Keine" → erste Gruppe): nur diese samt Untergruppen; deckt es alles ab, wird []', () => {
    expect(waehleNur(menge, 'atr-alko')).toEqual(['atr-alko', 'atr-limo', 'atr-saft'])
    expect(waehleNur([kat('p', 'P', null, 0), kat('c', 'C', 'p', 0)], 'p')).toEqual([])
    expect(waehleNur(menge, 'gibt-es-nicht')).toEqual([])
  })

  it('zaehlung zählt nur aktive Gruppen', () => {
    const m = [...menge, kat('alt', 'Alt', null, 9, false)]
    expect(zaehlung(m, [])).toEqual({ sichtbar: 14, gesamt: 14 })
    expect(zaehlung(m, ['grillen'])).toEqual({ sichtbar: 1, gesamt: 14 })
  })

  it('gespeicherte Liste ist immer die VOLLE Menge der an-Gruppen in Baumreihenfolge (auch für Verbraucher ohne Teilbaum-Auswertung)', () => {
    const r = toggle(menge, [], 'atr')
    // jede „an"-Gruppe steht explizit drin — auch die Untergruppen von Kellner Getränke
    expect(r.liste).toContain('kel-alko')
    expect(r.liste).toContain('kel-bier')
    // und ein flacher Verbraucher (nur `includes`) sähe exakt die an-Gruppen
    const flach = menge.filter(k => r.liste.includes(k.id)).map(k => k.id)
    expect(new Set(flach)).toEqual(new Set(r.liste))
    expect(r.liste).toEqual(BAUM_REIHENFOLGE.filter(id => r.liste.includes(id)))   // in Baumreihenfolge
  })
})
