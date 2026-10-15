import { describe, it, expect } from 'vitest'
import { hatBonRouting, wirksamesArtikelRouting, wirksamesKategorieRouting, type KasseRoutingAusnahme } from './kategorie-baum.js'

const k = (id: string, parentId: string | null, station: string | null = null, bonierdruckerId: string | null = null) =>
  ({ id, parentId, station, bonierdruckerId })

/** Ausnahme einer Warengruppe bzw. eines Artikels an EINER Kasse; ohne Angaben = keine Ausnahme. */
const ausn = (ziel: { kategorieId?: string; artikelId?: string }, o: Partial<KasseRoutingAusnahme> = {}): KasseRoutingAusnahme => ({
  kategorieId: ziel.kategorieId ?? null,
  artikelId:   ziel.artikelId ?? null,
  bonierdruckerId: null, keinDrucker: false, station: null, keineStation: false,
  ...o,
})

describe('wirksamesKategorieRouting: Station und Bonierdrucker werden von der Elterngruppe geerbt', () => {
  it('Untergruppe ohne eigene Angabe erbt die Station der Hauptgruppe (auch über mehrere Ebenen)', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank'),
      k('unter', 'haupt'),
      k('enkel', 'unter'),
    ])
    expect(r.get('haupt')).toEqual({ station: 'schank', bonierdruckerId: null })
    expect(r.get('unter')).toEqual({ station: 'schank', bonierdruckerId: null })
    expect(r.get('enkel')).toEqual({ station: 'schank', bonierdruckerId: null })
  })

  it('eigene Angabe der Untergruppe geht vor, die nächstgelegene Gruppe gewinnt', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank'),
      k('kueche', 'haupt', 'kueche'),
      k('kuechenkind', 'kueche'),
    ])
    expect(r.get('kueche')?.station).toBe('kueche')
    expect(r.get('kuechenkind')?.station).toBe('kueche')
  })

  it('Station und Drucker werden getrennt geerbt', () => {
    const r = wirksamesKategorieRouting([
      k('haupt', null, 'schank', 'drucker-haupt'),
      k('unter', 'haupt', null, 'drucker-eigen'),
    ])
    expect(r.get('unter')).toEqual({ station: 'schank', bonierdruckerId: 'drucker-eigen' })
  })

  it('ohne Angabe in der ganzen Kette: null; fehlender Elternteil und Zyklus brechen nicht ab', () => {
    const r = wirksamesKategorieRouting([
      k('a', null),
      k('b', 'fehlt'),
      k('x', 'y'),
      k('y', 'x', 'kueche'),
    ])
    expect(r.get('a')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('b')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('x')?.station).toBe('kueche')
  })
})

describe('wirksamesKategorieRouting mit Kassen-Ausnahmen', () => {
  const baum = [
    k('haupt', null, 'schank', 'drucker-bar'),
    k('unter', 'haupt'),
    k('eigen', 'haupt', 'kueche', 'drucker-kueche'),
  ]

  it('ohne Ausnahmen unverändert (auch mit leerer Liste)', () => {
    expect(wirksamesKategorieRouting(baum, [])).toEqual(wirksamesKategorieRouting(baum))
  })

  it('die Ausnahme ersetzt die Vorgabe der Gruppe — nur für den betroffenen Wert', () => {
    const r = wirksamesKategorieRouting(baum, [ausn({ kategorieId: 'haupt' }, { bonierdruckerId: 'drucker-terrasse' })])
    expect(r.get('haupt')).toEqual({ station: 'schank', bonierdruckerId: 'drucker-terrasse' })
  })

  it('eine Ausnahme der Hauptgruppe wird an Untergruppen ohne eigene Angabe vererbt — mit eigener Angabe nicht', () => {
    const r = wirksamesKategorieRouting(baum, [ausn({ kategorieId: 'haupt' }, { bonierdruckerId: 'drucker-terrasse', station: 'dessert' })])
    expect(r.get('unter')).toEqual({ station: 'dessert', bonierdruckerId: 'drucker-terrasse' })
    expect(r.get('eigen')).toEqual({ station: 'kueche', bonierdruckerId: 'drucker-kueche' })
  })

  it('eine Ausnahme der Untergruppe geht der eigenen Vorgabe und der Hauptgruppe vor', () => {
    const r = wirksamesKategorieRouting(baum, [ausn({ kategorieId: 'eigen' }, { bonierdruckerId: 'drucker-x' })])
    expect(r.get('eigen')).toEqual({ station: 'kueche', bonierdruckerId: 'drucker-x' })
  })

  it('„keiner" gilt ausdrücklich: weder Vorgabe der Gruppe noch der Elterngruppe greifen', () => {
    const r = wirksamesKategorieRouting(baum, [
      ausn({ kategorieId: 'unter' }, { keinDrucker: true }),
      ausn({ kategorieId: 'eigen' }, { keineStation: true }),
    ])
    expect(r.get('unter')).toEqual({ station: 'schank', bonierdruckerId: null })   // Drucker: keiner, Station geerbt
    expect(r.get('eigen')).toEqual({ station: null, bonierdruckerId: 'drucker-kueche' })
  })

  it('„keiner" an der Hauptgruppe wird an Untergruppen ohne eigene Angabe vererbt', () => {
    const r = wirksamesKategorieRouting(baum, [ausn({ kategorieId: 'haupt' }, { keinDrucker: true, keineStation: true })])
    expect(r.get('haupt')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('unter')).toEqual({ station: null, bonierdruckerId: null })
    expect(r.get('eigen')).toEqual({ station: 'kueche', bonierdruckerId: 'drucker-kueche' })
  })

  it('Artikel-Ausnahmen und Ausnahmen unbekannter Gruppen verändern das Gruppen-Routing nicht', () => {
    const r = wirksamesKategorieRouting(baum, [
      ausn({ artikelId: 'a1' }, { bonierdruckerId: 'drucker-x' }),
      ausn({ kategorieId: 'gibt-es-nicht' }, { bonierdruckerId: 'drucker-y' }),
    ])
    expect(r).toEqual(wirksamesKategorieRouting(baum))
  })
})

describe('wirksamesArtikelRouting: das Genauere gewinnt', () => {
  const gruppe = { station: 'schank', bonierdruckerId: 'drucker-bar' }

  it('ohne eigene Angabe gilt die Warengruppe', () => {
    expect(wirksamesArtikelRouting({ station: null, bonierdruckerId: null }, gruppe)).toEqual(gruppe)
  })

  it('ohne Warengruppe und ohne Angabe: nichts', () => {
    expect(wirksamesArtikelRouting({ station: null, bonierdruckerId: null }, undefined)).toEqual({ station: null, bonierdruckerId: null })
  })

  it('die eigene Angabe des Artikels geht der Warengruppe vor — Station und Drucker getrennt', () => {
    expect(wirksamesArtikelRouting({ station: 'kueche', bonierdruckerId: null }, gruppe))
      .toEqual({ station: 'kueche', bonierdruckerId: 'drucker-bar' })
  })

  it('die Ausnahme des Artikels an der Kasse geht auch seiner eigenen Angabe vor', () => {
    const r = wirksamesArtikelRouting(
      { station: 'kueche', bonierdruckerId: 'drucker-kueche' }, gruppe,
      ausn({ artikelId: 'a1' }, { bonierdruckerId: 'drucker-terrasse' }),
    )
    expect(r).toEqual({ station: 'kueche', bonierdruckerId: 'drucker-terrasse' })
  })

  it('„keiner" an der Kasse beendet die Kette — weder Artikel noch Warengruppe greifen', () => {
    const r = wirksamesArtikelRouting(
      { station: 'kueche', bonierdruckerId: 'drucker-kueche' }, gruppe,
      ausn({ artikelId: 'a1' }, { keinDrucker: true, keineStation: true }),
    )
    expect(r).toEqual({ station: null, bonierdruckerId: null })
    expect(hatBonRouting(r)).toBe(false)
  })

  it('hatBonRouting: Station ODER Drucker genügt', () => {
    expect(hatBonRouting({ station: 'kueche', bonierdruckerId: null })).toBe(true)
    expect(hatBonRouting({ station: null, bonierdruckerId: 'x' })).toBe(true)
    expect(hatBonRouting({ station: null, bonierdruckerId: null })).toBe(false)
  })
})
