import { describe, expect, it } from 'vitest'
import { korbNeuBepreisen, listenPreise, listenPreisFuer, type BepreisbarePosition } from './preisliste'

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

const pos = (id: string, normal: number, extra: Partial<BepreisbarePosition> = {}): BepreisbarePosition => ({
  typ: 'artikel', artikel: { id, preisBruttoCent: normal }, modifikatoren: [], preisCent: normal, originalPreisCent: normal, happyHourProzent: 0, ...extra,
})
// „Aktionsbasis" der Kasse: hier einfach der Artikelpreis, ohne Aktion
const ohneAktion = (a: { preisBruttoCent: number }) => ({ basisCent: a.preisBruttoCent, happyHourProzent: 0 })
// mit 10 % Happy Hour
const mitHappyHour = (a: { preisBruttoCent: number }) => ({ basisCent: Math.round(a.preisBruttoCent * 0.9), happyHourProzent: 10 })

const liste = listenPreise({ preislisteId: ID1, name: 'Tersus', preise: [{ artikelId: ID1, preisBruttoCent: 5400 }] })

describe('listenPreise / listenPreisFuer', () => {
  it('baut die Nachschlage-Tabelle; ohne Preisliste oder ohne Preise null', () => {
    expect(liste!.get(ID1)).toBe(5400)
    expect(listenPreise(null as never)).toBeNull()
    expect(listenPreise(undefined)).toBeNull()
    expect(listenPreise({ preislisteId: ID1, name: 'Leer', preise: [] })).toBeNull()
  })
  it('Listenpreis nur mit Eintrag und nie für Negativpreise (Pfand-Rückgabe)', () => {
    expect(listenPreisFuer(liste, { id: ID1, preisBruttoCent: 6000 })).toBe(5400)
    expect(listenPreisFuer(liste, { id: ID2, preisBruttoCent: 500 })).toBeNull()
    expect(listenPreisFuer(liste, { id: ID1, preisBruttoCent: -100 })).toBeNull()
    expect(listenPreisFuer(null, { id: ID1, preisBruttoCent: 6000 })).toBeNull()
  })
})

describe('korbNeuBepreisen', () => {
  it('setzt den Listenpreis, Artikel ohne Eintrag behalten den normalen Preis', () => {
    const korb = [pos(ID1, 6000), pos(ID2, 500)]
    const r = korbNeuBepreisen(korb, liste, ohneAktion)
    expect(r[0]).toMatchObject({ preisCent: 5400, originalPreisCent: 5400 })
    expect(r[1]).toBe(korb[1])                                       // unverändert, selbes Objekt
  })

  it('Aufschläge aus Optionen kommen zum Listenpreis dazu', () => {
    const r = korbNeuBepreisen([pos(ID1, 6000, { modifikatoren: [{ aufschlagCent: 250 }], preisCent: 6250, originalPreisCent: 6250 })], liste, ohneAktion)
    expect(r[0]).toMatchObject({ preisCent: 5650, originalPreisCent: 5650 })
  })

  it('Listenpreis ersetzt die Happy Hour (kein doppelter Nachlass); ohne Liste kehrt die Aktion zurück', () => {
    const listeNiedrig = listenPreise({ preislisteId: ID1, name: 'Tersus', preise: [{ artikelId: ID1, preisBruttoCent: 5000 }] })
    // normal 6000, Happy Hour −10 % = 5400, Listenpreis 5000
    const mitAktion = [pos(ID1, 6000, { preisCent: 5400, originalPreisCent: 5400, happyHourProzent: 10 })]
    const l = korbNeuBepreisen(mitAktion, listeNiedrig, mitHappyHour)
    expect(l[0]).toMatchObject({ preisCent: 5000, originalPreisCent: 5000, happyHourProzent: 0 })
    const zurueck = korbNeuBepreisen(l, null, mitHappyHour)
    expect(zurueck[0]).toMatchObject({ preisCent: 5400, originalPreisCent: 5400, happyHourProzent: 10 })
  })

  it('Kunde entfernt → Position zurück auf den normalen Preis', () => {
    const vorher = korbNeuBepreisen([pos(ID1, 6000)], liste, ohneAktion)
    expect(vorher[0]).toMatchObject({ preisCent: 5400 })
    const nachher = korbNeuBepreisen(vorher, null, ohneAktion)
    expect(nachher[0]).toMatchObject({ preisCent: 6000, originalPreisCent: 6000 })
  })

  it('von Hand rabattierte Position bleibt unangetastet', () => {
    const korb = [pos(ID1, 6000, { preisCent: 5000, originalPreisCent: 6000 })]
    expect(korbNeuBepreisen(korb, liste, ohneAktion)).toBe(korb)
  })

  it('freie Positionen und Negativartikel bleiben unverändert; ohne Änderung dasselbe Array', () => {
    const frei = { typ: 'frei', bezeichnung: 'Montage', menge: 1, preisCent: 9000 }
    const pfand = pos(ID1, -200)
    const korb = [frei, pfand]
    expect(korbNeuBepreisen(korb, liste, ohneAktion)).toBe(korb)
    expect(korbNeuBepreisen([pos(ID2, 500)], liste, ohneAktion)).toHaveLength(1)
  })

  it('wiederholtes Anwenden ist idempotent', () => {
    const einmal = korbNeuBepreisen([pos(ID1, 6000)], liste, ohneAktion)
    expect(korbNeuBepreisen(einmal, liste, ohneAktion)).toBe(einmal)
  })
})
