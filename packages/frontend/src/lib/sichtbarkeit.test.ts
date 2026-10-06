import { describe, it, expect } from 'vitest'
import { sichtbarkeitsMengen } from './kategorie-baum'
import {
  alleAktiv, alleAusblendenKlick, alleAusblendenTitel, alleSichtbarKlick, alleSichtbarTitel, anzeigeZustaende,
  auswahlStatus, gruppeKlick, istSichtbar, mitNeustart, SICHTBARKEIT_TEXTE, sichtbarkeitsZustaende, teilbaumKlick,
  toggle, toggleTeilbaum, uebernimm, waehleNur, zaehlung, zustandTitel, type Auswahl, type Uebergang,
} from './sichtbarkeit'
import { ALLE_IDS, asselloBaum, BAUM_REIHENFOLGE, kat } from './testdaten-kategorien'

const menge = asselloBaum()
const zustandVon = (liste: string[], id: string) => sichtbarkeitsZustaende(menge, liste).get(id)
const ohne = (...weg: string[]) => BAUM_REIHENFOLGE.filter(id => !weg.includes(id))
const ATR_TEILBAUM = ['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']

describe('Sichtbarkeit je Kasse: leere Liste = alle, jede Gruppe einzeln', () => {
  it('bei leerer Liste sind ALLE Gruppen „an" und sichtbar', () => {
    expect(alleAktiv([])).toBe(true)
    const z = sichtbarkeitsZustaende(menge, [])
    expect([...z.values()].every(v => v === 'an')).toBe(true)
    expect(z.size).toBe(ALLE_IDS.length)
    expect(istSichtbar(menge, [], 'ev-alko')).toBe(true)
    expect(zaehlung(menge, [])).toEqual({ sichtbar: 14, gesamt: 14 })
  })

  it('aus „alle" eine Gruppe abwählen → explizite Liste aller anderen; die Elterngruppe bleibt AN (eigene Wahl)', () => {
    const r = toggle(menge, [], 'kel-alko')
    expect(r.blockiert).toBeNull()
    expect(r.liste).toEqual(ohne('kel-alko'))
    expect(zustandVon(r.liste, 'kel-alko')).toBe('aus')
    expect(zustandVon(r.liste, 'kel')).toBe('an')           // Untergruppen werden einzeln gewählt — die Elterngruppe bleibt, was sie war
    expect(zustandVon(r.liste, 'kel-bier')).toBe('an')
    expect(zaehlung(menge, r.liste)).toEqual({ sichtbar: 13, gesamt: 14 })
  })

  it('aus „alle" eine Hauptgruppe abwählen schaltet NUR diese aus — ihre Untergruppen bleiben gewählt, die Gruppe wird Zugang', () => {
    const r = toggle(menge, [], 'atr')
    expect(r.liste).toEqual(ohne('atr'))
    expect(zustandVon(r.liste, 'atr')).toBe('zugang')       // halber Haken: nicht gewählt, aber Zugang zu den gewählten Untergruppen
    for (const id of ['atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']) expect(zustandVon(r.liste, id)).toBe('an')
    expect(zustandVon(r.liste, 'kel')).toBe('an')
    expect(zaehlung(menge, r.liste)).toEqual({ sichtbar: 13, gesamt: 14 })   // der Zugang zählt nicht als gewählt
  })

  it('gleichnamige Gruppen sind unabhängig: nur EINE „Alkoholfrei" abwählen', () => {
    const r = toggle(menge, [], 'ev-alko')
    expect(zustandVon(r.liste, 'ev-alko')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('an')
    expect(zustandVon(r.liste, 'kel-alko')).toBe('an')
    expect(zustandVon(r.liste, 'ev-pakete')).toBe('an')
    expect(zustandVon(r.liste, 'ev')).toBe('an')
  })

  it('wieder alle Gruppen an → [] (alle sichtbar) wird gespeichert', () => {
    const ohneGrillen = toggle(menge, [], 'grillen').liste
    expect(ohneGrillen).toEqual(ohne('grillen'))
    expect(toggle(menge, ohneGrillen, 'grillen').liste).toEqual([])
    // auch über den Halbzustand: Atriumbar ab (wird Zugang), dann anklicken → wieder gewählt → alles an
    const teil = toggle(menge, [], 'atr').liste
    expect(zustandVon(teil, 'atr')).toBe('zugang')
    expect(toggle(menge, teil, 'atr').liste).toEqual([])
  })

  it('die LETZTE gewählte Gruppe lässt sich nicht abwählen', () => {
    const r = toggle(menge, ['grillen'], 'grillen')
    expect(r.blockiert).toBe('letzte')
    expect(r.liste).toEqual(['grillen'])
    // auch nicht, wenn sie eine Elterngruppe ist (ihre Untergruppen sind ja nicht mitgewählt)
    expect(toggle(menge, waehleNur(menge, 'atr'), 'atr').blockiert).toBe('letzte')
    // und nicht aus „alle" bei nur einer Gruppe
    expect(toggle([kat('x', 'X', null, 0)], [], 'x').blockiert).toBe('letzte')
  })
})

describe('Untergruppen einzeln wählen (Elterngruppen schalten NICHT den Teilbaum)', () => {
  it('NUR „Alkoholfrei" der Atriumbar wählen — ohne Limonaden und Säfte', () => {
    const r = toggle(menge, ['grillen'], 'atr-alko')
    expect(r.liste).toEqual(['atr-alko', 'grillen'])
    expect(zustandVon(r.liste, 'atr-alko')).toBe('an')
    expect(zustandVon(r.liste, 'atr-limo')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
    expect(zustandVon(r.liste, 'atr')).toBe('zugang')       // die Atriumbar bleibt nur als Zugang
    expect(zustandVon(r.liste, 'atr-bier')).toBe('aus')
    // gleichnamige Gruppen in anderen Teilbäumen unberührt
    expect(zustandVon(r.liste, 'kel-alko')).toBe('aus')
    expect(istSichtbar(menge, r.liste, 'atr')).toBe(true)   // Zugang = sichtbar als Reiter/Kachel
    expect(istSichtbar(menge, r.liste, 'atr-limo')).toBe(false)
  })

  it('danach „Limonaden" zusätzlich wählen → nur diese kommt dazu', () => {
    const start = toggle(menge, ['grillen'], 'atr-alko').liste
    const r = toggle(menge, start, 'atr-limo')
    expect(r.liste).toEqual(['atr-alko', 'atr-limo', 'grillen'])
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
  })

  it('Eltern einschalten schaltet die Untergruppen NICHT mit ein', () => {
    const r = toggle(menge, ['grillen'], 'atr')
    expect(r.liste).toEqual(['atr', 'grillen'])
    expect(zustandVon(r.liste, 'atr')).toBe('an')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('aus')
    expect(zustandVon(r.liste, 'atr-limo')).toBe('aus')
  })

  it('Eltern ausschalten lässt die gewählten Untergruppen stehen', () => {
    const start = toggle(menge, ['grillen'], 'atr').liste        // atr an
    const mitKind = toggle(menge, start, 'atr-wein').liste       // + Wein
    const r = toggle(menge, mitKind, 'atr')                      // atr wieder ab
    expect(r.liste).toEqual(['atr-wein', 'grillen'])
    expect(zustandVon(r.liste, 'atr')).toBe('zugang')
    expect(zustandVon(r.liste, 'atr-wein')).toBe('an')
  })

  it('ein Haken auf einer Zugangs-Gruppe wählt sie selbst (die Untergruppen bleiben, wie sie sind)', () => {
    const r = toggle(menge, ['atr-limo'], 'atr-alko')
    expect(r.liste).toEqual(['atr-alko', 'atr-limo'])
    expect(zustandVon(r.liste, 'atr-alko')).toBe('an')
    expect(zustandVon(r.liste, 'atr')).toBe('zugang')
  })

  it('sind danach alle Untergruppen gewählt, wird die Elterngruppe NICHT automatisch gewählt (kein Hochziehen)', () => {
    let liste = ['grillen']
    for (const id of ['atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein']) liste = toggle(menge, liste, id).liste
    expect(zustandVon(liste, 'atr')).toBe('zugang')
    expect(liste).toEqual(['atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein', 'grillen'])
  })

  it('eine Gruppe, die nur Zugang ist, verschwindet, sobald die letzte gewählte Untergruppe abgewählt wird', () => {
    const start = toggle(menge, ['grillen'], 'atr-wein').liste        // atr = Zugang
    expect(zustandVon(start, 'atr')).toBe('zugang')
    const r = toggle(menge, start, 'atr-wein')
    expect(r.liste).toEqual(['grillen'])
    expect(zustandVon(r.liste, 'atr')).toBe('aus')
  })

  it('Enkel gewählt: beide Vorfahren sind Zugang', () => {
    const r = toggle(menge, ['grillen'], 'atr-limo')
    expect(zustandVon(r.liste, 'atr-alko')).toBe('zugang')
    expect(zustandVon(r.liste, 'atr')).toBe('zugang')
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
  })
})

describe('Komfort „samt Untergruppen" (eigener Knopf, nicht der Standard-Klick)', () => {
  it('schaltet die Gruppe und ALLE Nachkommen auf einmal ein', () => {
    const r = toggleTeilbaum(menge, ['grillen'], 'atr')
    expect(r.liste).toEqual([...ATR_TEILBAUM, 'grillen'])
    expect(zustandVon(r.liste, 'atr-limo')).toBe('an')
  })

  it('sind schon alle gewählt, schaltet er alle aus', () => {
    const start = toggleTeilbaum(menge, ['grillen'], 'atr').liste
    const r = toggleTeilbaum(menge, start, 'atr')
    expect(r.liste).toEqual(['grillen'])
    expect(zustandVon(r.liste, 'atr-saft')).toBe('aus')
  })

  it('ist nur ein Teil gewählt, werden alle gewählt (nicht abgewählt)', () => {
    const r = toggleTeilbaum(menge, ['atr', 'grillen'], 'atr')
    expect(r.liste).toEqual([...ATR_TEILBAUM, 'grillen'])
  })

  it('aus „alle sichtbar": ganzer Teilbaum ab; Untergruppe einer Untergruppe: nur deren Teilbaum', () => {
    expect(toggleTeilbaum(menge, [], 'atr').liste).toEqual(ohne(...ATR_TEILBAUM))
    const r = toggleTeilbaum(menge, [], 'atr-alko')
    expect(r.liste).toEqual(ohne('atr-alko', 'atr-limo', 'atr-saft'))
    expect(zustandVon(r.liste, 'atr')).toBe('an')                  // die Elterngruppe selbst bleibt gewählt
  })

  it('die letzte gewählte Gruppe bleibt auch hier; ein Blatt verhält sich wie der einfache Klick', () => {
    expect(toggleTeilbaum(menge, ATR_TEILBAUM, 'atr')).toEqual({ liste: ATR_TEILBAUM, blockiert: 'letzte' })
    expect(toggleTeilbaum(menge, ['grillen', 'kel-bier'], 'kel-bier')).toEqual(toggle(menge, ['grillen', 'kel-bier'], 'kel-bier'))
    expect(toggleTeilbaum(menge, ['grillen'], 'gibt-es-nicht')).toEqual({ liste: ['grillen'], blockiert: null })
  })

  it('waehleNur: nur diese Gruppe — mit samtUntergruppen auch alle Nachkommen; deckt es alles ab, wird []', () => {
    expect(waehleNur(menge, 'atr')).toEqual(['atr'])
    expect(waehleNur(menge, 'atr-alko')).toEqual(['atr-alko'])
    expect(waehleNur(menge, 'atr-alko', true)).toEqual(['atr-alko', 'atr-limo', 'atr-saft'])
    expect(waehleNur(menge, 'atr', true)).toEqual(ATR_TEILBAUM)
    expect(waehleNur([kat('p', 'P', null, 0), kat('c', 'C', 'p', 0)], 'p', true)).toEqual([])
    expect(waehleNur([kat('x', 'X', null, 0)], 'x')).toEqual([])
    expect(waehleNur(menge, 'gibt-es-nicht')).toEqual([])
  })
})

describe('gespeicherte Listen aus älteren Ständen und Randfälle', () => {
  it('Liste nur mit der Elterngruppe: die Untergruppen sind NICHT dabei (jede Gruppe zählt einzeln)', () => {
    expect(zustandVon(['kel'], 'kel')).toBe('an')
    expect(zustandVon(['kel'], 'kel-alko')).toBe('aus')
    expect(zustandVon(['kel'], 'kel-bier')).toBe('aus')
    expect(zustandVon(['kel'], 'atr')).toBe('aus')
  })

  it('Liste mit allen Untergruppen, aber ohne die Elterngruppe: die Elterngruppe ist Zugang', () => {
    expect(zustandVon(['kel-alko', 'kel-bier'], 'kel')).toBe('zugang')
  })

  it('ältere Liste mit vollem Teilbaum (Gruppe + alle Untergruppen) verhält sich unverändert', () => {
    const z = sichtbarkeitsZustaende(menge, ATR_TEILBAUM)
    for (const id of ATR_TEILBAUM) expect(z.get(id)).toBe('an')
    expect(z.get('kel')).toBe('aus')
    expect(zaehlung(menge, ATR_TEILBAUM)).toEqual({ sichtbar: 6, gesamt: 14 })
  })

  it('die Oberfläche und die Kasse lesen dieselbe Liste gleich (sichtbarkeitsMengen aus @kassa/shared)', () => {
    for (const liste of [[], ['atr-alko'], ['atr', 'atr-limo'], ['kel-bier', 'grillen'], ATR_TEILBAUM]) {
      const kasse = sichtbarkeitsMengen(menge, liste)
      const editor = sichtbarkeitsZustaende(menge, liste)
      for (const k of menge) {
        const erwartet = kasse.sichtbar.has(k.id) ? 'an' : kasse.zugang.has(k.id) ? 'zugang' : 'aus'
        expect(editor.get(k.id), `${k.id} bei ${JSON.stringify(liste)}`).toBe(erwartet)
      }
    }
  })

  it('unbekannte IDs werden ignoriert; ohne bekannte Gruppe ist nichts sichtbar (wie an der Kasse)', () => {
    expect(zustandVon(['gibt-es-nicht'], 'atr')).toBe('aus')
    expect(istSichtbar(menge, ['gibt-es-nicht'], 'atr')).toBe(false)
    expect(toggle(menge, ['grillen'], 'gibt-es-nicht')).toEqual({ liste: ['grillen'], blockiert: null })
  })

  it('zaehlung zählt nur aktive Gruppen — und nur die gewählten (ein reiner Zugang zählt nicht)', () => {
    const m = [...menge, kat('alt', 'Alt', null, 9, false)]
    expect(zaehlung(m, [])).toEqual({ sichtbar: 14, gesamt: 14 })
    expect(zaehlung(m, ['grillen'])).toEqual({ sichtbar: 1, gesamt: 14 })
    expect(zaehlung(m, ['atr-limo'])).toEqual({ sichtbar: 1, gesamt: 14 })
  })

  it('gespeicherte Liste ist immer die VOLLE Menge der gewählten Gruppen in Baumreihenfolge (auch für Verbraucher ohne Zugangs-Auswertung)', () => {
    const r = toggle(menge, [], 'atr')
    expect(r.liste).toContain('atr-alko')
    expect(r.liste).toContain('kel-bier')
    const flach = menge.filter(k => r.liste.includes(k.id)).map(k => k.id)
    expect(new Set(flach)).toEqual(new Set(r.liste))
    expect(r.liste).toEqual(BAUM_REIHENFOLGE.filter(id => r.liste.includes(id)))   // in Baumreihenfolge
  })
})

// ---------------------------------------------------------------------------
// „Alle sichtbar" / „Alle ausblenden" je Kasse
// ---------------------------------------------------------------------------

const alle: Auswahl = { liste: [], neustart: false }
const teil = (liste: string[]): Auswahl => ({ liste, neustart: false })

/** Spielt die Oberfläche EINER Kasse nach: Klicks anwenden und mitschreiben, was gespeichert würde. */
function kasse(start: Auswahl) {
  let a = start
  const geschrieben: string[][] = []
  const wende = (u: Uebergang) => {
    if (u.speichern) geschrieben.push(u.speichern)
    a = uebernimm(a, u)
    return u
  }
  return {
    zustand:        () => a,
    status:         () => auswahlStatus(menge, a),
    geschrieben,
    alleSichtbar:   () => wende(alleSichtbarKlick(a)),
    alleAusblenden: () => wende(alleAusblendenKlick(a)),
    gruppe:         (id: string) => wende(gruppeKlick(menge, a, id)),
    teilbaum:       (id: string) => wende(teilbaumKlick(menge, a, id)),
  }
}

describe('„Alle sichtbar" / „Alle ausblenden": Zustand je Kasse', () => {
  it('Beschriftung: „alle sichtbar" / „N von M sichtbar" / „alle ausgeblendet (Auswahl wird gleich neu begonnen)"', () => {
    expect(auswahlStatus(menge, alle)).toEqual({ art: 'alle', sichtbar: 14, gesamt: 14, text: 'alle sichtbar' })
    expect(auswahlStatus(menge, teil(['grillen']))).toEqual({ art: 'teilweise', sichtbar: 1, gesamt: 14, text: '1 von 14 sichtbar' })
    expect(auswahlStatus(menge, teil(ATR_TEILBAUM))).toMatchObject({ art: 'teilweise', text: '6 von 14 sichtbar' })
    expect(auswahlStatus(menge, { liste: [], neustart: true }))
      .toEqual({ art: 'keine', sichtbar: 0, gesamt: 14, text: 'alle ausgeblendet (Auswahl wird gleich neu begonnen)' })
    // der Neustart überdeckt auch eine gespeicherte Auswahl
    expect(auswahlStatus(menge, { liste: ['grillen'], neustart: true }).art).toBe('keine')
  })

  it('im Neustart zeigen ALLE Haken „aus" — auch bei gespeicherter Auswahl; sonst gilt die gespeicherte Liste', () => {
    const neustart = anzeigeZustaende(menge, { liste: ['grillen'], neustart: true })
    expect(neustart.size).toBe(ALLE_IDS.length)
    expect([...neustart.values()].every(z => z === 'aus')).toBe(true)
    expect(anzeigeZustaende(menge, teil(['grillen'])).get('grillen')).toBe('an')
    expect(anzeigeZustaende(menge, teil(['atr-limo'])).get('atr')).toBe('zugang')
    expect([...anzeigeZustaende(menge, alle).values()].every(z => z === 'an')).toBe(true)
  })
})

describe('Toggle-Komfort: derselbe Knopf schaltet zwischen „alle sichtbar" und „alle ausgeblendet"', () => {
  it('„Alle sichtbar" bei „alle sichtbar" → alle ausgeblendet (nichts gespeichert); „Alle ausblenden" dort → zurück', () => {
    const k = kasse(alle)
    k.alleSichtbar()
    expect(k.status().art).toBe('keine')
    expect(k.zustand()).toEqual({ liste: [], neustart: true })
    k.alleAusblenden()
    expect(k.status().art).toBe('alle')
    expect(k.zustand()).toEqual({ liste: [], neustart: false })
    expect(k.geschrieben).toEqual([])          // der Server stand die ganze Zeit auf [] — es wird nie geschrieben
  })

  it('„Alle ausblenden" bei „alle sichtbar" → alle ausgeblendet; „Alle sichtbar" dort → zurück (nichts gespeichert)', () => {
    const k = kasse(alle)
    k.alleAusblenden()
    expect(k.status().art).toBe('keine')
    k.alleSichtbar()
    expect(k.status().art).toBe('alle')
    expect(k.geschrieben).toEqual([])
  })

  it('beliebig oft hintereinander: jeder Klick wechselt, der Serverstand bleibt []', () => {
    const k = kasse(alle)
    const folge = ['alleSichtbar', 'alleSichtbar', 'alleSichtbar', 'alleAusblenden', 'alleAusblenden', 'alleAusblenden'] as const
    const arten = folge.map(klick => { k[klick](); return k.status().art })
    expect(arten).toEqual(['keine', 'alle', 'keine', 'alle', 'keine', 'alle'])
    expect(k.geschrieben).toEqual([])
    expect(k.zustand().liste).toEqual([])
  })

  it('aus „N von M sichtbar": „Alle sichtbar" speichert [] — es wechselt nicht auf „keine"', () => {
    const k = kasse(teil(toggle(menge, [], 'atr').liste))
    expect(k.status().art).toBe('teilweise')
    k.alleSichtbar()
    expect(k.geschrieben).toEqual([[]])
    expect(k.status().art).toBe('alle')
  })

  it('aus „N von M sichtbar": „Alle ausblenden" beginnt nur den Neustart — nichts gespeichert, der Serverstand bleibt', () => {
    const vorher = toggle(menge, [], 'atr').liste
    const k = kasse(teil(vorher))
    expect(k.alleAusblenden()).toEqual({ neustart: true, speichern: null, blockiert: null })
    expect(k.geschrieben).toEqual([])
    expect(k.zustand()).toEqual({ liste: vorher, neustart: true })
    expect(k.status().art).toBe('keine')
    // erneuter Klick: zurück auf „alle sichtbar" — jetzt wird [] gespeichert (der Serverstand war nicht leer)
    k.alleAusblenden()
    expect(k.geschrieben).toEqual([[]])
    expect(k.zustand()).toEqual({ liste: [], neustart: false })
  })

  it('Neustart aus „N von M sichtbar" und dann „Alle sichtbar" → alle sichtbar ([] gespeichert)', () => {
    const k = kasse(teil(['grillen']))
    k.alleAusblenden()
    k.alleSichtbar()
    expect(k.geschrieben).toEqual([[]])
    expect(k.status().art).toBe('alle')
  })

  it('Verlassen/Neuladen verwirft den Neustart: aus dem Serverstand entsteht wieder „N von M" bzw. „alle sichtbar" — nie still „alle ausgeblendet"', () => {
    for (const stand of [[], toggle(menge, [], 'atr').liste, ['grillen']]) {
      const k = kasse(teil(stand))
      k.alleAusblenden()
      expect(k.status().art).toBe('keine')
      // neue Komponente = Zustand aus dem gespeicherten Stand, ohne Neustart-Merker
      const neu: Auswahl = { liste: k.zustand().liste, neustart: false }
      expect(auswahlStatus(menge, neu).art).toBe(stand.length === 0 ? 'alle' : 'teilweise')
      expect(auswahlStatus(menge, neu).sichtbar).toBeGreaterThan(0)
      expect(k.geschrieben).toEqual([])
    }
  })
})

describe('Erste Gruppe nach „Alle ausblenden"', () => {
  it('speichert NUR diese Gruppe (ohne Untergruppen) und beendet den Neustart', () => {
    const k = kasse(alle)
    k.alleAusblenden()
    expect(k.gruppe('atr-alko')).toEqual({ neustart: false, speichern: ['atr-alko'], blockiert: null })
    expect(k.geschrieben).toEqual([['atr-alko']])
    expect(k.zustand()).toEqual({ liste: ['atr-alko'], neustart: false })
    expect(k.status()).toMatchObject({ art: 'teilweise', sichtbar: 1, gesamt: 14, text: '1 von 14 sichtbar' })
    expect(sichtbarkeitsZustaende(menge, k.zustand().liste).get('atr-limo')).toBe('aus')
    expect(sichtbarkeitsZustaende(menge, k.zustand().liste).get('atr')).toBe('zugang')
  })

  it('„samt Untergruppen" nach dem Neustart: genau dieser Teilbaum wird die neue Auswahl', () => {
    const k = kasse(alle)
    k.alleAusblenden()
    expect(k.teilbaum('atr')).toEqual({ neustart: false, speichern: ATR_TEILBAUM, blockiert: null })
    expect(k.geschrieben).toEqual([ATR_TEILBAUM])
    expect(k.status()).toMatchObject({ art: 'teilweise', sichtbar: 6, text: '6 von 14 sichtbar' })
    expect(sichtbarkeitsZustaende(menge, k.zustand().liste).get('kel')).toBe('aus')
  })

  it('ersetzt die bisherige Auswahl (ergänzt sie nicht); eine einzelne Untergruppe lässt ihre Elterngruppe als Zugang sichtbar', () => {
    const k = kasse(teil(['grillen', 'kel', 'kel-alko', 'kel-bier']))
    k.alleAusblenden()
    k.gruppe('atr-wein')
    expect(k.zustand().liste).toEqual(['atr-wein'])
    expect(sichtbarkeitsZustaende(menge, ['atr-wein']).get('atr')).toBe('zugang')
  })

  it('deckt die gewählte Gruppe alles ab, wird [] gespeichert (dann ist wörtlich alles sichtbar)', () => {
    expect(gruppeKlick([kat('x', 'X', null, 0)], { liste: [], neustart: true }, 'x'))
      .toEqual({ neustart: false, speichern: [], blockiert: null })
    const m = [kat('p', 'P', null, 0), kat('c', 'C', 'p', 0)]
    expect(teilbaumKlick(m, { liste: [], neustart: true }, 'p')).toEqual({ neustart: false, speichern: [], blockiert: null })
    // ohne Untergruppen deckt „p" nicht alles ab → nur diese Gruppe
    expect(gruppeKlick(m, { liste: [], neustart: true }, 'p')).toEqual({ neustart: false, speichern: ['p'], blockiert: null })
  })

  it('eine unbekannte Gruppe wird ignoriert — im Neustart wird dabei NICHTS gespeichert ([] hieße „alle sichtbar")', () => {
    for (const klick of [gruppeKlick, teilbaumKlick]) {
      expect(klick(menge, { liste: [], neustart: true }, 'gibt-es-nicht')).toEqual({ neustart: true, speichern: null, blockiert: null })
      expect(klick(menge, teil(['grillen']), 'gibt-es-nicht')).toEqual({ neustart: false, speichern: null, blockiert: null })
    }
  })

  it('danach gelten wieder die normalen Haken: weitere Gruppe einschalten, ausschalten — die letzte bleibt', () => {
    const k = kasse(alle)
    k.alleAusblenden()
    k.gruppe('grillen')
    k.gruppe('kel-bier')
    expect(k.zustand().liste).toEqual(['kel-bier', 'grillen'])        // Baumreihenfolge
    k.gruppe('kel-bier')
    expect(k.zustand().liste).toEqual(['grillen'])
    const u = k.gruppe('grillen')
    expect(u).toEqual({ neustart: false, speichern: null, blockiert: 'letzte' })
    expect(k.zustand().liste).toEqual(['grillen'])
  })

  it('die „letzte gewählte Gruppe"-Regel gilt auch aus „alle sichtbar" mit nur einer Gruppe', () => {
    expect(gruppeKlick([kat('x', 'X', null, 0)], alle, 'x')).toEqual({ neustart: false, speichern: null, blockiert: 'letzte' })
    expect(teilbaumKlick([kat('x', 'X', null, 0)], alle, 'x')).toEqual({ neustart: false, speichern: null, blockiert: 'letzte' })
  })
})

describe('„Alle ausblenden" speichert nie etwas Fehlerhaftes (alle Klickfolgen bis Tiefe 3)', () => {
  const starts: Auswahl[] = [
    alle,
    teil(['grillen']),
    teil(waehleNur(menge, 'atr', true)),
    { liste: [], neustart: true },
    { liste: ['grillen'], neustart: true },
  ]
  const aktionen: [string, (a: Auswahl) => Uebergang][] = [
    ['Alle sichtbar', alleSichtbarKlick],
    ['Alle ausblenden', alleAusblendenKlick],
    ...ALLE_IDS.map((id): [string, (a: Auswahl) => Uebergang] => [`Gruppe ${id}`, (a) => gruppeKlick(menge, a, id)]),
    ...['atr', 'atr-alko', 'kel', 'grillen'].map((id): [string, (a: Auswahl) => Uebergang] => [`Teilbaum ${id}`, (a) => teilbaumKlick(menge, a, id)]),
  ]

  it('gespeichert wird nur [] (alle) oder eine nicht leere Liste bekannter Gruppen; ein Neustart schreibt nie; ohne Neustart ist nie „nichts sichtbar"', () => {
    const verstoesse: string[] = []
    let geprueft = 0
    const lauf = (a: Auswahl, tiefe: number, pfad: string[]): void => {
      if (tiefe === 0) return
      for (const [name, aktion] of aktionen) {
        const u = aktion(a)
        const wo = `${JSON.stringify(a)} → ${[...pfad, name].join(' → ')}`
        const neu = uebernimm(a, u)
        geprueft++
        if (u.speichern && !u.speichern.every(id => ALLE_IDS.includes(id))) verstoesse.push(`${wo}: unbekannte Gruppe gespeichert`)
        if (u.speichern && u.speichern.length > 0 && zaehlung(menge, u.speichern).sichtbar === 0) verstoesse.push(`${wo}: Auswahl ohne gewählte Gruppe gespeichert`)
        if (u.speichern && u.speichern.length === 0 && auswahlStatus(menge, neu).art !== 'alle') verstoesse.push(`${wo}: [] gespeichert, aber nicht „alle sichtbar"`)
        if (u.neustart && u.speichern !== null) verstoesse.push(`${wo}: Neustart und gleichzeitig gespeichert`)
        if (u.blockiert && (u.speichern !== null || JSON.stringify(neu.liste) !== JSON.stringify(a.liste))) verstoesse.push(`${wo}: blockiert, aber etwas geändert`)
        if (!neu.neustart && auswahlStatus(menge, neu).sichtbar === 0) verstoesse.push(`${wo}: ohne Neustart nichts gewählt`)
        lauf(neu, tiefe - 1, [...pfad, name])
      }
    }
    for (const s of starts) lauf(s, 3, [])
    expect(verstoesse).toEqual([])
    expect(geprueft).toBeGreaterThan(40_000)   // 5 Startzustände × (20 + 20² + 20³) Klicks
  })
})

describe('mehrere Kassen (Matrix-Spalten) bleiben getrennt', () => {
  it('der Neustart einer Kasse berührt die anderen nie; die Eingabemenge wird nicht verändert', () => {
    const leer: ReadonlySet<string> = new Set()
    const a = mitNeustart(leer, 'bar', true)
    expect([...a]).toEqual(['bar'])
    expect(leer.size).toBe(0)
    const b = mitNeustart(a, 'kueche', true)
    expect([...b].sort()).toEqual(['bar', 'kueche'])
    expect([...a]).toEqual(['bar'])
    const c = mitNeustart(b, 'bar', false)
    expect([...c]).toEqual(['kueche'])
    expect(mitNeustart(c, 'kueche', true).has('kueche')).toBe(true)      // idempotent
    expect(mitNeustart(c, 'gibt-es-nicht', false).size).toBe(1)
  })

  it('jede Spalte rechnet mit ihrer eigenen Liste und ihrem eigenen Neustart-Merker', () => {
    const listen: Record<string, string[]> = { bar: [], kueche: toggle(menge, [], 'atr').liste, terrasse: ['grillen'] }
    let neustart: ReadonlySet<string> = new Set()
    const status = (id: string) => auswahlStatus(menge, { liste: listen[id]!, neustart: neustart.has(id) })
    const arten = () => ['bar', 'kueche', 'terrasse'].map(id => status(id).art)
    expect(arten()).toEqual(['alle', 'teilweise', 'teilweise'])

    // Klick „Alle ausblenden" in der Spalte „bar": Neustart nur dort
    neustart = mitNeustart(neustart, 'bar', alleAusblendenKlick({ liste: listen.bar!, neustart: neustart.has('bar') }).neustart)
    expect(arten()).toEqual(['keine', 'teilweise', 'teilweise'])
    expect(status('kueche').text).toBe('13 von 14 sichtbar')
    expect(status('terrasse').text).toBe('1 von 14 sichtbar')

    // erster Haken in der Spalte „bar" (Gruppe Grillen): nur „bar" wird gespeichert und verlässt den Neustart
    const u = gruppeKlick(menge, { liste: listen.bar!, neustart: neustart.has('bar') }, 'grillen')
    neustart = mitNeustart(neustart, 'bar', u.neustart)
    listen.bar = u.speichern ?? listen.bar!
    expect(listen).toEqual({ bar: ['grillen'], kueche: toggle(menge, [], 'atr').liste, terrasse: ['grillen'] })
    expect(arten()).toEqual(['teilweise', 'teilweise', 'teilweise'])
    expect(neustart.size).toBe(0)
  })
})

describe('Texte und Tooltips (gemeinsam für Matrix und POS-Konfiguration)', () => {
  it('Wortlaut der Beschriftungen und Hinweise', () => {
    expect(SICHTBARKEIT_TEXTE).toMatchObject({
      statusAlle:      'alle sichtbar',
      statusKeine:     'alle ausgeblendet (Auswahl wird gleich neu begonnen)',
      knopfAlle:       'Alle sichtbar',
      knopfAusblenden: 'Alle ausblenden',
      neustartHinweis: 'Noch nichts gespeichert — die erste Warengruppe, die du jetzt einschaltest, legt die neue Auswahl fest. Solange gilt die bisherige Auswahl weiter.',
      letzteHinweis:   'Mindestens eine Warengruppe muss an dieser Kasse sichtbar bleiben.',
    })
    expect(SICHTBARKEIT_TEXTE.teilbaumTitel).toContain('samt allen Untergruppen')
  })

  it('die Tooltips erklären den jeweiligen Klick', () => {
    expect(alleSichtbarTitel('alle')).toContain('blendet alle aus')
    expect(alleSichtbarTitel('teilweise')).toContain('künftig angelegte')
    expect(alleSichtbarTitel('keine')).toContain('Zurück')
    expect(alleAusblendenTitel('teilweise')).toContain('nichts gespeichert')
    expect(alleAusblendenTitel('alle')).toBe(alleAusblendenTitel('teilweise'))
    expect(alleAusblendenTitel('keine')).toContain('abbrechen')
  })

  it('der Tooltip eines Hakens erklärt die drei Zustände — vor allem den Zugang', () => {
    expect(zustandTitel('an', 'Atriumbar › Alkoholfrei')).toContain('Untergruppen werden einzeln gewählt')
    expect(zustandTitel('zugang', 'Atriumbar')).toContain('Zugang')
    expect(zustandTitel('zugang', 'Atriumbar')).toContain('ohne eigene Artikel')
    expect(zustandTitel('aus', 'Atriumbar')).toContain('ausgeblendet')
    expect(zustandTitel('aus', 'Atriumbar')).toMatch(/^Atriumbar — /)
  })
})
