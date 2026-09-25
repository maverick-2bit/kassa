import { describe, it, expect } from 'vitest'
import type { Artikel, Kategorie } from '@kassa/shared'
import {
  artikelDerKasse,
  FAVORITEN_TAB_ID,
  sichtbareWarengruppen,
  SONSTIGE_TAB_ID,
  startReiter,
  type ReiterLage,
} from './artikel-reiter'

const kat = (id: string, reihenfolge: number, aktiv = true) =>
  ({ id, name: id, reihenfolge, aktiv }) as Kategorie
const art = (id: string, kategorieId: string | null) => ({ id, kategorieId }) as Artikel

describe('sichtbareWarengruppen / artikelDerKasse', () => {
  const kategorien = [kat('speisen', 2), kat('getraenke', 1), kat('alt', 0, false)]

  it('aktive Warengruppen in Kassen-Reihenfolge, gefiltert nach der Kassen-Sichtbarkeit', () => {
    expect(sichtbareWarengruppen(kategorien, []).map(k => k.id)).toEqual(['getraenke', 'speisen'])
    expect(sichtbareWarengruppen(kategorien, ['speisen']).map(k => k.id)).toEqual(['speisen'])
  })

  it('mit Sichtbarkeits-Liste bleiben nur deren Artikel — auch keine ohne Warengruppe', () => {
    const artikel = [art('bier', 'getraenke'), art('schnitzel', 'speisen'), art('pfand', null)]
    expect(artikelDerKasse(artikel, ['speisen']).map(a => a.id)).toEqual(['schnitzel'])
    expect(artikelDerKasse(artikel, undefined)).toHaveLength(3)
  })
})

describe('startReiter', () => {
  const lage: ReiterLage = {
    hatFavoriten: true,
    hatSonstige:  false,
    kategorieIds: ['leer', 'getraenke', 'speisen'],
    kategorieIdsMitArtikeln: ['getraenke', 'speisen'],
  }

  it('Standard: Favoriten zuerst', () => {
    expect(startReiter(lage, {})).toBe(FAVORITEN_TAB_ID)
  })

  it('eingestellte Warengruppe', () => {
    expect(startReiter(lage, { startFavoriten: false, startKategorieId: 'speisen' })).toBe('speisen')
  })

  it('„erste Warengruppe" = erste mit Artikeln, nicht die Favoriten', () => {
    expect(startReiter(lage, { startFavoriten: false, startKategorieId: null })).toBe('getraenke')
  })

  it('ausgeblendete Warengruppe oder fehlende Favoriten → nächster sinnvoller Reiter', () => {
    expect(startReiter(lage, { startFavoriten: false, startKategorieId: 'weg' })).toBe('getraenke')
    expect(startReiter({ ...lage, hatFavoriten: false }, { startFavoriten: true })).toBe('getraenke')
  })

  it('ausdrücklicher Wunsch (?tab=favoriten) überstimmt die Einstellung', () => {
    expect(startReiter(lage, { startFavoriten: false, startKategorieId: 'speisen' }, FAVORITEN_TAB_ID))
      .toBe(FAVORITEN_TAB_ID)
  })

  it('nur Artikel ohne Warengruppe → „Sonstige"; gar nichts → null', () => {
    const nurSonstige: ReiterLage = { hatFavoriten: false, hatSonstige: true, kategorieIds: [], kategorieIdsMitArtikeln: [] }
    expect(startReiter(nurSonstige, {})).toBe(SONSTIGE_TAB_ID)
    expect(startReiter({ ...nurSonstige, hatSonstige: false }, {})).toBeNull()
  })
})
