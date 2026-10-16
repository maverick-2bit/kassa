import { describe, expect, it } from 'vitest'
import {
  einzigeWarengruppe, FAVORITEN_TAB_ID, SONSTIGE_TAB_ID, startReiter, type ReiterLage,
} from './start-reiter.js'

const lage = (o: Partial<ReiterLage> = {}): ReiterLage => ({
  hatFavoriten: true, hatSonstige: false,
  kategorieIds: ['leer', 'getraenke', 'speisen'], kategorieIdsMitArtikeln: ['getraenke', 'speisen'], ...o,
})
/** Eine Kasse mit genau einer Warengruppe (die hat Artikel) */
const einzeln = (o: Partial<ReiterLage> = {}): ReiterLage =>
  lage({ kategorieIds: ['kellner'], kategorieIdsMitArtikeln: ['kellner'], ...o })

describe('startReiter: die Einstellung der Kasse', () => {
  it('Standard: Favoriten zuerst', () => {
    expect(startReiter(lage(), {})).toBe(FAVORITEN_TAB_ID)
  })

  it('eingestellte Warengruppe', () => {
    expect(startReiter(lage(), { startFavoriten: false, startKategorieId: 'speisen' })).toBe('speisen')
  })

  it('„erste Warengruppe" = erste mit Artikeln, nicht die Favoriten', () => {
    expect(startReiter(lage(), { startFavoriten: false, startKategorieId: null })).toBe('getraenke')
  })

  it('ausgeblendete Warengruppe oder fehlende Favoriten → nächster sinnvoller Reiter', () => {
    expect(startReiter(lage(), { startFavoriten: false, startKategorieId: 'weg' })).toBe('getraenke')
    expect(startReiter(lage({ hatFavoriten: false }), { startFavoriten: true })).toBe('getraenke')
  })

  it('ausdrücklicher Wunsch (?tab=favoriten) überstimmt die Einstellung', () => {
    expect(startReiter(lage(), { startFavoriten: false, startKategorieId: 'speisen' }, FAVORITEN_TAB_ID)).toBe(FAVORITEN_TAB_ID)
  })

  it('nur Artikel ohne Warengruppe → „Sonstige"; gar nichts → null', () => {
    const nurSonstige: ReiterLage = { hatFavoriten: false, hatSonstige: true, kategorieIds: [], kategorieIdsMitArtikeln: [] }
    expect(startReiter(nurSonstige, {})).toBe(SONSTIGE_TAB_ID)
    expect(startReiter({ ...nurSonstige, hatSonstige: false }, {})).toBeNull()
  })
})

describe('Genau eine Warengruppe: sie öffnet sich von selbst', () => {
  it('einzigeWarengruppe: nur bei genau einer Warengruppe MIT Artikeln', () => {
    expect(einzigeWarengruppe(einzeln())).toBe('kellner')
    expect(einzigeWarengruppe(lage())).toBeNull()                                                       // mehrere
    expect(einzigeWarengruppe(einzeln({ kategorieIdsMitArtikeln: [] }))).toBeNull()                      // ohne Artikel
    expect(einzigeWarengruppe(einzeln({ kategorieIds: [], kategorieIdsMitArtikeln: [] }))).toBeNull()    // keine
  })

  it('auch wenn es Favoriten gibt und die Einstellung „Favoriten" sagt (der Standard)', () => {
    expect(startReiter(einzeln(), {})).toBe('kellner')
    expect(startReiter(einzeln(), { startFavoriten: true })).toBe('kellner')
  })

  it('„erste Warengruppe" und die Wahl genau dieser Warengruppe führen zum selben Ergebnis', () => {
    expect(startReiter(einzeln(), { startFavoriten: false, startKategorieId: null })).toBe('kellner')
    expect(startReiter(einzeln(), { startFavoriten: false, startKategorieId: 'kellner' })).toBe('kellner')
  })

  it('auch neben dem „Sonstige"-Reiter (Artikel ohne Warengruppe) zählt nur die Warengruppe', () => {
    expect(startReiter(einzeln({ hatSonstige: true }), {})).toBe('kellner')
  })

  it('nur ein ausdrücklicher Wunsch geht vor: ?tab=favoriten bleibt Favoriten', () => {
    expect(startReiter(einzeln(), {}, FAVORITEN_TAB_ID)).toBe(FAVORITEN_TAB_ID)
  })

  it('ohne Favoriten sowieso; eine leere einzige Warengruppe lässt die bisherige Regel gelten', () => {
    expect(startReiter(einzeln({ hatFavoriten: false }), {})).toBe('kellner')
    const leer = einzeln({ kategorieIdsMitArtikeln: [], hatSonstige: true })
    expect(startReiter(leer, { startFavoriten: false })).toBe(FAVORITEN_TAB_ID)       // Favoriten vor einer leeren Gruppe
    expect(startReiter({ ...leer, hatFavoriten: false }, {})).toBe(SONSTIGE_TAB_ID)   // Sonstige vor einer leeren Gruppe
  })

  it('mit mehreren Warengruppen ändert sich nichts', () => {
    expect(startReiter(lage(), {})).toBe(FAVORITEN_TAB_ID)
    expect(startReiter(lage(), { startFavoriten: false, startKategorieId: 'speisen' })).toBe('speisen')
  })
})
