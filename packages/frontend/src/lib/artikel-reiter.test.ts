import { describe, it, expect } from 'vitest'
import type { Artikel, Kategorie } from '@kassa/shared'
import {
  artikelDerKasse,
  artikelErlaubt,
  FAVORITEN_TAB_ID,
  gruppenRaster,
  kassenAnsicht,
  sichtbareWarengruppen,
  SONSTIGE_TAB_ID,
  startReiter,
  type ReiterLage,
} from './artikel-reiter'
import { sichtbarkeitsMengen } from './kategorie-baum'
import { asselloBaum } from './testdaten-kategorien'

const kat = (id: string, reihenfolge: number, aktiv = true) =>
  ({ id, name: id, reihenfolge, aktiv }) as Kategorie
const art = (id: string, kategorieId: string | null) => ({ id, kategorieId }) as Artikel

describe('sichtbareWarengruppen / artikelDerKasse', () => {
  const kategorien = [kat('speisen', 2), kat('getraenke', 1), kat('alt', 0, false)]

  it('aktive Warengruppen in Kassen-Reihenfolge, gefiltert nach der Kassen-Sichtbarkeit', () => {
    expect(sichtbareWarengruppen(kategorien, sichtbarkeitsMengen(kategorien, [])).map(k => k.id)).toEqual(['getraenke', 'speisen'])
    expect(sichtbareWarengruppen(kategorien, sichtbarkeitsMengen(kategorien, ['speisen'])).map(k => k.id)).toEqual(['speisen'])
  })

  it('mit Sichtbarkeits-Liste bleiben nur deren Artikel — auch keine ohne Warengruppe', () => {
    const artikel = [art('bier', 'getraenke'), art('schnitzel', 'speisen'), art('pfand', null)]
    expect(artikelDerKasse(artikel, sichtbarkeitsMengen(kategorien, ['speisen'])).map(a => a.id)).toEqual(['schnitzel'])
    expect(artikelDerKasse(artikel, sichtbarkeitsMengen(kategorien, undefined))).toHaveLength(3)
    expect(artikelErlaubt(art('pfand', null), sichtbarkeitsMengen(kategorien, ['speisen']))).toBe(false)
    expect(artikelErlaubt(art('pfand', null), sichtbarkeitsMengen(kategorien, []))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Artikelwahl der Kasse (ArtikelGrid → Kasse und Tisch): jede Warengruppe einzeln gewählt
// ---------------------------------------------------------------------------

describe('kassenAnsicht / gruppenRaster: Untergruppen werden nicht automatisch mitgewählt', () => {
  const kategorien = asselloBaum()
  /** Je Gruppe ein bis zwei Artikel (Name = ID + Nummer), dazu einer ohne Warengruppe */
  const artikel = [
    ...kategorien.flatMap(k => [1, 2].map(n => ({
      id: `${k.id}-a${n}`, bezeichnung: `${k.id} ${n}`, kategorieId: k.id, reihenfolge: n,
      rasterPosition: null, istBestandteil: false,
    }) as unknown as Artikel)),
    { id: 'pfand', bezeichnung: 'Pfand', kategorieId: null, reihenfolge: 0, rasterPosition: null, istBestandteil: false } as unknown as Artikel,
  ]
  const ansicht = (ids: string[]) => kassenAnsicht(kategorien, artikel, ids)
  const kacheln = (a: ReturnType<typeof ansicht>, gruppeId: string) =>
    gruppenRaster(a, gruppeId).flatMap(z => z.typ === 'gruppe' ? [z.gruppe.id] : [])
  const artikelIds = (a: ReturnType<typeof ansicht>, gruppeId: string) =>
    gruppenRaster(a, gruppeId).flatMap(z => z.typ === 'artikel' ? [z.artikel.id] : [])

  it('ohne Einschränkung: alle Reiter, alle Kacheln, alle Artikel — auch der ohne Warengruppe', () => {
    const a = ansicht([])
    expect(a.reiter.map(k => k.id)).toEqual(['atr', 'kel', 'ev', 'grillen'])
    expect(kacheln(a, 'atr')).toEqual(['atr-alko', 'atr-bier', 'atr-wein'])
    expect(kacheln(a, 'atr-alko')).toEqual(['atr-limo', 'atr-saft'])
    expect(a.artikel.some(x => x.id === 'pfand')).toBe(true)
  })

  it('NUR „Alkoholfrei" der Atriumbar gewählt: seine Artikel erscheinen, aber KEINE Kacheln für Limonaden/Säfte', () => {
    const a = ansicht(['atr-alko'])
    expect(artikelIds(a, 'atr-alko')).toEqual(['atr-alko-a1', 'atr-alko-a2'])
    expect(kacheln(a, 'atr-alko')).toEqual([])                       // Limonaden und Säfte sind nicht gewählt
    expect(a.artikel.some(x => x.kategorieId === 'atr-limo' || x.kategorieId === 'atr-saft')).toBe(false)
  })

  it('die Atriumbar ist dabei nur ZUGANG: Reiter mit einer Kachel „Alkoholfrei", ohne eigene Artikel und ohne Bier/Wein', () => {
    const a = ansicht(['atr-alko'])
    expect(a.reiter.map(k => k.id)).toEqual(['atr'])                 // nur der Zugang, keine anderen Hauptgruppen
    expect(kacheln(a, 'atr')).toEqual(['atr-alko'])                  // nicht gewählte Geschwister (Bier, Wein) fehlen
    expect(artikelIds(a, 'atr')).toEqual([])                         // keine eigenen Artikel der Zugangs-Gruppe
    expect(a.artikel.some(x => x.kategorieId === 'atr')).toBe(false)
    expect(a.artikel.some(x => x.id === 'pfand')).toBe(false)        // mit Einschränkung nie Artikel ohne Warengruppe
  })

  it('danach „Limonaden" zusätzlich gewählt → die Kachel erscheint in „Alkoholfrei"; „Säfte" bleibt weg', () => {
    const a = ansicht(['atr-alko', 'atr-limo'])
    expect(kacheln(a, 'atr-alko')).toEqual(['atr-limo'])
    expect(artikelIds(a, 'atr-limo')).toEqual(['atr-limo-a1', 'atr-limo-a2'])
    expect(a.artikel.some(x => x.kategorieId === 'atr-saft')).toBe(false)
  })

  it('nur Elterngruppe gewählt: ihre Artikel, aber keine Untergruppen-Kacheln', () => {
    const a = ansicht(['atr'])
    expect(artikelIds(a, 'atr')).toEqual(['atr-a1', 'atr-a2'])
    expect(kacheln(a, 'atr')).toEqual([])
    expect(a.reiter.map(k => k.id)).toEqual(['atr'])
  })

  it('Elterngruppe + eine Untergruppe: eigene Artikel und nur diese Kachel', () => {
    const a = ansicht(['atr', 'atr-bier'])
    expect(artikelIds(a, 'atr')).toEqual(['atr-a1', 'atr-a2'])
    expect(kacheln(a, 'atr')).toEqual(['atr-bier'])
  })

  it('gewählte Enkelgruppe: Zugang über zwei Ebenen (Atriumbar → Alkoholfrei → Limonaden), beide ohne eigene Artikel', () => {
    const a = ansicht(['atr-limo'])
    expect(a.reiter.map(k => k.id)).toEqual(['atr'])
    expect(kacheln(a, 'atr')).toEqual(['atr-alko'])
    expect(artikelIds(a, 'atr')).toEqual([])
    expect(kacheln(a, 'atr-alko')).toEqual(['atr-limo'])
    expect(artikelIds(a, 'atr-alko')).toEqual([])
    expect(artikelIds(a, 'atr-limo')).toEqual(['atr-limo-a1', 'atr-limo-a2'])
  })

  it('Untergruppen unter verschiedenen Eltern: je Eltern ein Zugang, gleichnamige Gruppen bleiben getrennt', () => {
    const a = ansicht(['kel-alko', 'ev-alko'])
    expect(a.reiter.map(k => k.id)).toEqual(['kel', 'ev'])
    expect(kacheln(a, 'kel')).toEqual(['kel-alko'])                  // Kellner › Alkoholfrei, nicht Kellner › Bier
    expect(kacheln(a, 'ev')).toEqual(['ev-pakete'])
    expect(kacheln(a, 'ev-pakete')).toEqual(['ev-alko'])
    expect(a.artikel.some(x => x.kategorieId === 'atr-alko')).toBe(false)
  })

  it('ältere Liste mit vollem Teilbaum: Gruppe samt allen Untergruppen sichtbar, wie bisher', () => {
    const a = ansicht(['atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein'])
    expect(kacheln(a, 'atr')).toEqual(['atr-alko', 'atr-bier', 'atr-wein'])
    expect(kacheln(a, 'atr-alko')).toEqual(['atr-limo', 'atr-saft'])
    expect(a.reiter.map(k => k.id)).toEqual(['atr'])
  })

  it('Rohstoffe/Bestandteile erscheinen nie; inaktive Gruppen auch nicht', () => {
    const mitRohstoff = [...artikel, { ...artikel[0]!, id: 'roh', istBestandteil: true } as Artikel]
    expect(kassenAnsicht(kategorien, mitRohstoff, []).artikel.some(x => x.id === 'roh')).toBe(false)
    const inaktiv = kategorien.map(k => k.id === 'atr-alko' ? { ...k, aktiv: false } : k)
    const a = kassenAnsicht(inaktiv, artikel, [])
    expect(a.gruppen.some(k => k.id === 'atr-alko')).toBe(false)
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
