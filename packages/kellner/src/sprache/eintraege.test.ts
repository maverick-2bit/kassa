import { describe, it, expect } from 'vitest'
import type { SprachVorschlag, SpracheBestellungErgebnis } from '@kassa/shared'
import {
  aendereMenge, alternativeGewaehlt, anzeigeStatus, auswahlArtikel, ausErgebnis, hinweiseFuer, MENGE_MAX, optionenFuer, tischStimmt,
  vorlesetextFuer, waehleArtikel,
} from './eintraege'

const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const vorschlag = (o: Partial<SprachVorschlag> = {}): SprachVorschlag => ({
  menge: 2, text: 'pizza', artikel: { id: G(1), bezeichnung: 'Pizza Margherita' }, konfidenz: 0.9, status: 'pruefen',
  alternativen: [{ id: G(2), bezeichnung: 'Pizza Salami', konfidenz: 0.9 }],
  modifikatoren: [{ id: G(10), gruppeId: G(20), name: 'Extra Käse' }],
  hinweise: ['ohne senf'],
  ...o,
})
const ergebnis = (...v: SprachVorschlag[]): SpracheBestellungErgebnis => ({ tisch: null, platz: null, vorschlaege: v, vorlesetext: '' })

describe('Sprach-Einträge', () => {
  it('macht aus dem Ergebnis Einträge mit fortlaufender Nummer', () => {
    const e = ausErgebnis(ergebnis(vorschlag(), vorschlag({ artikel: null, status: 'unbekannt', menge: 1 })), 5)
    expect(e.map(x => [x.id, x.artikelId, x.menge])).toEqual([[5, G(1), 2], [6, null, 1]])
  })

  it('Menge: 1 bis 99', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag({ menge: 1 })), 0)
    expect(aendereMenge(e!, -1).menge).toBe(1)
    expect(aendereMenge(e!, +1).menge).toBe(2)
    expect(aendereMenge({ ...e!, menge: MENGE_MAX }, +1).menge).toBe(MENGE_MAX)
  })

  it('Alternative wählen: Optionen des ersten Treffers entfallen, Hinweise bleiben, Status gilt als bestätigt', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag()), 0)
    expect(alternativeGewaehlt(e!)).toBe(false)
    expect(optionenFuer(e!)).toHaveLength(1)
    expect(anzeigeStatus(e!)).toBe('pruefen')

    const anders = waehleArtikel(e!, G(2))
    expect(alternativeGewaehlt(anders)).toBe(true)
    expect(optionenFuer(anders)).toEqual([])
    expect(hinweiseFuer(anders)).toEqual(['ohne senf'])
    expect(anzeigeStatus(anders)).toBe('sicher')

    // zurück zum besten Treffer
    expect(alternativeGewaehlt(waehleArtikel(anders, G(1)))).toBe(false)
  })

  it('nicht erkannt → Status unbekannt', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag({ artikel: null, status: 'unbekannt', alternativen: [] })), 0)
    expect(anzeigeStatus(e!)).toBe('unbekannt')
    expect(auswahlArtikel(e!)).toEqual([])
  })

  it('Auswahl: bester Treffer zuerst, dann die Alternativen', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag()), 0)
    expect(auswahlArtikel(e!).map(a => a.id)).toEqual([G(1), G(2)])
  })
})

describe('Sprach-Vorlesetext', () => {
  it('liest die aktuelle Liste vor, mit Optionen und Hinweisen; alles sicher → „Richtig?"', () => {
    const e = ausErgebnis(ergebnis(vorschlag({ status: 'sicher', hinweise: [], menge: 2 })), 0)
    expect(vorlesetextFuer(e)).toBe('zwei Pizza Margherita Extra Käse. Richtig?')
  })

  it('Unsicheres, Hinweise und Unverstandenes → „Bitte prüfen."', () => {
    const e = ausErgebnis(ergebnis(vorschlag(), vorschlag({ artikel: null, status: 'unbekannt', text: 'sushi', alternativen: [], modifikatoren: [], hinweise: [] })), 0)
    expect(vorlesetextFuer(e)).toBe('zwei Pizza Margherita Extra Käse ohne senf, unklar: sushi. Bitte prüfen.')
  })

  it('spiegelt Änderungen: gewählte Alternative (ohne deren Optionen) und neue Menge', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag({ status: 'sicher', hinweise: [] })), 0)
    expect(vorlesetextFuer([aendereMenge(waehleArtikel(e!, G(2)), +1)])).toBe('drei Pizza Salami. Richtig?')
  })

  it('große Mengen als Ziffer, leere Liste', () => {
    const [e] = ausErgebnis(ergebnis(vorschlag({ status: 'sicher', hinweise: [], modifikatoren: [], menge: 15 })), 0)
    expect(vorlesetextFuer([e!])).toBe('15 Pizza Margherita. Richtig?')
    expect(vorlesetextFuer([])).toBe('Nichts verstanden.')
  })
})

describe('Sprach-Tisch', () => {
  it('„Tisch 12", „12" und „tisch12" sind derselbe Tisch; fehlende Angabe stört nicht', () => {
    expect(tischStimmt('12', 'Tisch 12')).toBe(true)
    expect(tischStimmt('A3', 'tisch a3')).toBe(true)
    expect(tischStimmt('12', 'Tisch 5')).toBe(false)
    expect(tischStimmt(null, 'Tisch 5')).toBe(true)
    expect(tischStimmt('12', null)).toBe(true)
  })
})
