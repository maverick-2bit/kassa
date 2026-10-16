import { describe, it, expect } from 'vitest'
import type { Kategorie, RoutingAusnahme } from '@kassa/shared'
import {
  ausnahmenNachZelle,
  wendeAenderungenAn,
  bonierdruckerVerwendung,
  hatAngabe,
  kassenIdsFolge,
  kassenName,
  naechsteKassenIds,
  routingAenderung,
  routingJeKasse,
  startReiterAuswahl,
  startReiterFelder,
  startReiterWert,
  zellenSchluessel,
  zellenWert,
} from './einrichtung'

const ausn = (o: Partial<RoutingAusnahme> & { kasseId: string }): RoutingAusnahme => ({
  kategorieId: null, artikelId: null, bonierdruckerId: null, keinDrucker: false, station: null, keineStation: false, ...o,
})

describe('naechsteKassenIds: setzt die Schreibweise der vorhandenen IDs fort', () => {
  it('ohne Kassen: KASSE-001', () => {
    expect(naechsteKassenIds([], 1)).toEqual(['KASSE-001'])
  })

  it('KASSE-001, KASSE-002 → KASSE-003 (gleiche Stellenzahl)', () => {
    expect(naechsteKassenIds(['KASSE-001', 'KASSE-002'], 1)).toEqual(['KASSE-003'])
  })

  it('mehrere auf einmal zählen weiter', () => {
    expect(naechsteKassenIds(['KASSE-001', 'KASSE-002'], 3)).toEqual(['KASSE-003', 'KASSE-004', 'KASSE-005'])
  })

  it('das häufigste Präfix gewinnt; bei Gleichstand die höchste Nummer', () => {
    expect(naechsteKassenIds(['BAR-1', 'BAR-2', 'K-9'], 1)).toEqual(['BAR-3'])
    expect(naechsteKassenIds(['BAR-1', 'K-9'], 1)).toEqual(['K-10'])
  })

  it('IDs ohne Nummer zählen nicht — es beginnt bei KASSE-001', () => {
    expect(naechsteKassenIds(['HAUPTKASSE'], 1)).toEqual(['KASSE-001'])
  })

  it('Lücken werden nicht gefüllt, belegte IDs (auch in anderer Schreibweise) übersprungen', () => {
    expect(naechsteKassenIds(['KASSE-001', 'KASSE-004'], 1)).toEqual(['KASSE-005'])
    expect(naechsteKassenIds(['kasse-001', 'KASSE-002'], 1)).toEqual(['KASSE-003'])
  })

  it('die Stellenzahl wächst mit: KASSE-009 → KASSE-010', () => {
    expect(naechsteKassenIds(['KASSE-009'], 2)).toEqual(['KASSE-010', 'KASSE-011'])
  })

  it('E2E-Schreibweise mit Bindestrich im Präfix: E2E-KASSE-01 → E2E-KASSE-02', () => {
    expect(naechsteKassenIds(['E2E-KASSE-01'], 1)).toEqual(['E2E-KASSE-02'])
  })
})

describe('kassenName', () => {
  it('Bezeichnung, sonst Kassen-ID', () => {
    expect(kassenName({ bezeichnung: 'Bar Terrasse', kassenId: 'K-1' })).toBe('Bar Terrasse')
    expect(kassenName({ bezeichnung: null, kassenId: 'K-1' })).toBe('K-1')
    expect(kassenName({ bezeichnung: '', kassenId: 'K-1' })).toBe('K-1')
  })
})

describe('Matrix-Zelle: Wert und Änderung', () => {
  it('ohne Ausnahme: Standard (leer)', () => {
    expect(zellenWert(undefined, 'drucker')).toBe('')
    expect(zellenWert(undefined, 'station')).toBe('')
  })

  it('Drucker und Station einer Ausnahme getrennt', () => {
    const a = ausn({ kasseId: 'k', kategorieId: 'g', bonierdruckerId: 'dr', station: 'kueche' })
    expect(zellenWert(a, 'drucker')).toBe('dr')
    expect(zellenWert(a, 'station')).toBe('kueche')
  })

  it('„keiner" gilt je Merkmal', () => {
    const a = ausn({ kasseId: 'k', kategorieId: 'g', keinDrucker: true, station: 'schank' })
    expect(zellenWert(a, 'drucker')).toBe('keiner')
    expect(zellenWert(a, 'station')).toBe('schank')
    expect(hatAngabe(a, 'drucker')).toBe(true)
    expect(hatAngabe(ausn({ kasseId: 'k', kategorieId: 'g', station: 'schank' }), 'drucker')).toBe(false)
  })

  it('Änderung Drucker: leer = Standard (null), „keiner" und ID gehen unverändert an den Server', () => {
    expect(routingAenderung('k', { kategorieId: 'g' }, 'drucker', '')).toEqual({ kasseId: 'k', kategorieId: 'g', drucker: null })
    expect(routingAenderung('k', { kategorieId: 'g' }, 'drucker', 'keiner')).toEqual({ kasseId: 'k', kategorieId: 'g', drucker: 'keiner' })
    expect(routingAenderung('k', { artikelId: 'a' }, 'drucker', 'dr-1')).toEqual({ kasseId: 'k', artikelId: 'a', drucker: 'dr-1' })
  })

  it('Änderung Station: „keiner" heißt auf dem Server „keine"', () => {
    expect(routingAenderung('k', { kategorieId: 'g' }, 'station', '')).toEqual({ kasseId: 'k', kategorieId: 'g', station: null })
    expect(routingAenderung('k', { kategorieId: 'g' }, 'station', 'keiner')).toEqual({ kasseId: 'k', kategorieId: 'g', station: 'keine' })
    expect(routingAenderung('k', { artikelId: 'a' }, 'station', 'kueche')).toEqual({ kasseId: 'k', artikelId: 'a', station: 'kueche' })
  })

  it('Ausnahmen nach Zelle: Warengruppe und Artikel getrennt, je Kasse', () => {
    const m = ausnahmenNachZelle([
      ausn({ kasseId: 'k1', kategorieId: 'g', bonierdruckerId: 'dr' }),
      ausn({ kasseId: 'k2', kategorieId: 'g', station: 'kueche' }),
      ausn({ kasseId: 'k1', artikelId: 'g', keinDrucker: true }),   // gleiche ID, anderer Typ
    ])
    expect(m.get(zellenSchluessel('k1', { kategorieId: 'g' }))?.bonierdruckerId).toBe('dr')
    expect(m.get(zellenSchluessel('k2', { kategorieId: 'g' }))?.station).toBe('kueche')
    expect(m.get(zellenSchluessel('k1', { artikelId: 'g' }))?.keinDrucker).toBe(true)
    expect(m.get(zellenSchluessel('k3', { kategorieId: 'g' }))).toBeUndefined()
  })
})

describe('routingJeKasse: das Routing DIESER Kasse (Vorgabe + Ausnahmen, mit Vererbung)', () => {
  const kat = (id: string, parentId: string | null, station: string | null = null, bonierdruckerId: string | null = null) =>
    ({ id, parentId, station, bonierdruckerId })
  const baum = [kat('haupt', null, 'schank', 'bar'), kat('unter', 'haupt')]

  it('ohne Ausnahme: die allgemeine Vorgabe, an Untergruppen vererbt', () => {
    expect(routingJeKasse(baum, [], 'k1').get('unter')).toEqual({ station: 'schank', bonierdruckerId: 'bar' })
  })

  it('eine Ausnahme gilt nur an ihrer Kasse', () => {
    const a = [ausn({ kasseId: 'k1', kategorieId: 'haupt', bonierdruckerId: 'terrasse' })]
    expect(routingJeKasse(baum, a, 'k1').get('unter')?.bonierdruckerId).toBe('terrasse')
    expect(routingJeKasse(baum, a, 'k2').get('unter')?.bonierdruckerId).toBe('bar')
  })
})

describe('bonierdruckerVerwendung: wofür ein Bonierdrucker eingesetzt ist', () => {
  it('zählt Warengruppen, Artikel, Kassen-Ausnahmen, KDS-Stationen und Fallback', () => {
    const v = bonierdruckerVerwendung('d1', {
      kategorien:     [{ name: 'Getränke', bonierdruckerId: 'd1' }, { name: 'Speisen', bonierdruckerId: 'd2' }, { name: 'Eis', bonierdruckerId: null }],
      artikel:        [{ bonierdruckerId: 'd1' }, { bonierdruckerId: 'd1' }, { bonierdruckerId: 'd2' }, { bonierdruckerId: null }],
      ausnahmen:      [{ bonierdruckerId: 'd1' }, { bonierdruckerId: null }, { bonierdruckerId: 'd2' }],
      stationDrucker: [{ station: 'kueche', bonierdruckerId: 'd1' }, { station: 'schank', bonierdruckerId: 'd2' }],
      fallbackId:     'd1',
    })
    expect(v).toEqual({ warengruppen: ['Getränke'], artikel: 2, ausnahmen: 1, stationen: ['kueche'], fallback: true })
  })

  it('ein ungenutzter Drucker hat überall nichts', () => {
    const v = bonierdruckerVerwendung('d9', { kategorien: [], artikel: [], ausnahmen: [], stationDrucker: [], fallbackId: null })
    expect(v).toEqual({ warengruppen: [], artikel: 0, ausnahmen: 0, stationen: [], fallback: false })
  })
})

describe('wendeAenderungenAn: wie der Server (sofortige Anzeige)', () => {
  it('legt eine Ausnahme an und lässt andere Kassen/Ziele unberührt', () => {
    const vorher = [ausn({ kasseId: 'k2', kategorieId: 'g', station: 'kueche' })]
    const nachher = wendeAenderungenAn(vorher, [{ kasseId: 'k1', kategorieId: 'g', drucker: 'dr' }])
    expect(nachher).toHaveLength(2)
    expect(nachher.find(a => a.kasseId === 'k1')).toMatchObject({ kategorieId: 'g', bonierdruckerId: 'dr', keinDrucker: false })
    expect(nachher.find(a => a.kasseId === 'k2')).toMatchObject({ station: 'kueche' })
  })

  it('ändert nur das angegebene Merkmal — das andere bleibt', () => {
    const vorher = [ausn({ kasseId: 'k', kategorieId: 'g', bonierdruckerId: 'dr', station: 'kueche' })]
    expect(wendeAenderungenAn(vorher, [{ kasseId: 'k', kategorieId: 'g', station: null }])[0])
      .toMatchObject({ bonierdruckerId: 'dr', station: null, keineStation: false })
  })

  it('„keiner"/„keine" und ID schließen sich je Merkmal aus', () => {
    const a1 = wendeAenderungenAn([], [{ kasseId: 'k', artikelId: 'a', drucker: 'keiner', station: 'keine' }])[0]!
    expect(a1).toMatchObject({ artikelId: 'a', kategorieId: null, bonierdruckerId: null, keinDrucker: true, station: null, keineStation: true })
    const a2 = wendeAenderungenAn([a1], [{ kasseId: 'k', artikelId: 'a', drucker: 'dr' }])[0]!
    expect(a2).toMatchObject({ bonierdruckerId: 'dr', keinDrucker: false, keineStation: true })
  })

  it('eine Ausnahme ohne jede Angabe verschwindet', () => {
    const vorher = [ausn({ kasseId: 'k', kategorieId: 'g', bonierdruckerId: 'dr' })]
    expect(wendeAenderungenAn(vorher, [{ kasseId: 'k', kategorieId: 'g', drucker: null }])).toEqual([])
  })

  it('mehrere Änderungen derselben Zelle gelten der Reihe nach', () => {
    const r = wendeAenderungenAn([], [
      { kasseId: 'k', kategorieId: 'g', drucker: 'keiner' },
      { kasseId: 'k', kategorieId: 'g', drucker: 'dr' },
      { kasseId: 'k', kategorieId: 'h', drucker: 'dr' },
      { kasseId: 'k', kategorieId: 'h', drucker: null },
    ])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kategorieId: 'g', bonierdruckerId: 'dr', keinDrucker: false })
  })

  it('verändert das übergebene Feld nicht (Cache-Daten bleiben unangetastet)', () => {
    const vorher = [ausn({ kasseId: 'k', kategorieId: 'g', bonierdruckerId: 'dr' })]
    wendeAenderungenAn(vorher, [{ kasseId: 'k', kategorieId: 'g', drucker: null }])
    expect(vorher[0]!.bonierdruckerId).toBe('dr')
  })
})

describe('kassenIdsFolge: mehrere Kassen auf einmal anlegen', () => {
  it('eine Kasse: die ID bleibt genau wie eingegeben', () => {
    expect(kassenIdsFolge('  Bar-A  ', 1)).toEqual(['Bar-A'])
  })

  it('zählt die Endnummer hoch und behält die Stellenzahl', () => {
    expect(kassenIdsFolge('KASSE-004', 3)).toEqual(['KASSE-004', 'KASSE-005', 'KASSE-006'])
    expect(kassenIdsFolge('K-9', 3)).toEqual(['K-9', 'K-10', 'K-11'])
  })

  it('ohne Endnummer: -1, -2, … angehängt', () => {
    expect(kassenIdsFolge('BAR', 2)).toEqual(['BAR-1', 'BAR-2'])
  })
})

// ---------------------------------------------------------------------------
// Start-Reiter der Artikelwahl (Spalte „Artikelwahl startet mit")
// ---------------------------------------------------------------------------

describe('startReiterWert / startReiterFelder: Auswahl ↔ gespeicherte Felder', () => {
  it('Favoriten, erste Warengruppe und eine bestimmte Warengruppe — hin und zurück', () => {
    expect(startReiterWert({ startFavoriten: true,  startKategorieId: null })).toBe('favoriten')
    expect(startReiterWert({ startFavoriten: false, startKategorieId: null })).toBe('erste')
    expect(startReiterWert({ startFavoriten: false, startKategorieId: 'g1' })).toBe('g1')

    for (const wert of ['favoriten', 'erste', 'g1']) {
      expect(startReiterWert(startReiterFelder(wert))).toBe(wert)
    }
  })

  it('Favoriten setzen die Warengruppe zurück; eine Warengruppe schaltet die Favoriten ab', () => {
    expect(startReiterFelder('favoriten')).toEqual({ startFavoriten: true,  startKategorieId: null })
    expect(startReiterFelder('erste')).toEqual({ startFavoriten: false, startKategorieId: null })
    expect(startReiterFelder('g1')).toEqual({ startFavoriten: false, startKategorieId: 'g1' })
  })

  it('solange die Favoriten an sind, zählt eine alte Warengruppe nicht', () => {
    expect(startReiterWert({ startFavoriten: true, startKategorieId: 'g1' })).toBe('favoriten')
  })
})

describe('startReiterAuswahl: was eine Kasse als Reiter zeigt', () => {
  const k = (id: string, name: string, o: Partial<Kategorie> = {}) =>
    ({ id, name, reihenfolge: 0, aktiv: true, parentId: null, ...o }) as Kategorie
  const kategorien = [
    k('kg', 'Kellner Getränke', { reihenfolge: 0 }),
    k('bier', 'Bier', { parentId: 'kg' }),
    k('ks', 'Kellner Speisen', { reihenfolge: 1 }),
    k('buero', 'Büro', { reihenfolge: 2 }),
  ]

  it('ohne Einschränkung: alle Warengruppen in Baumreihenfolge mit Pfad, die Hauptgruppen als Reiter', () => {
    const a = startReiterAuswahl(kategorien, [])
    expect(a.gruppen.map(g => g.pfad)).toEqual(['Kellner Getränke', 'Kellner Getränke › Bier', 'Kellner Speisen', 'Büro'])
    expect(a.reiter.map(r => r.id)).toEqual(['kg', 'ks', 'buero'])
  })

  it('an einer Kasse mit eingeschränkten Warengruppen: nur die dort erreichbaren', () => {
    const a = startReiterAuswahl(kategorien, ['ks', 'buero'])
    expect(a.gruppen.map(g => g.id)).toEqual(['ks', 'buero'])
    expect(a.reiter.map(r => r.id)).toEqual(['ks', 'buero'])
  })

  it('genau EINE Warengruppe → genau ein Reiter (sie öffnet sich von selbst)', () => {
    expect(startReiterAuswahl(kategorien, ['kg']).reiter.map(r => r.id)).toEqual(['kg'])
    expect(startReiterAuswahl([k('allein', 'Allein')], []).reiter.map(r => r.id)).toEqual(['allein'])
  })

  it('eine Untergruppe als einzige gewählt: ihre Hauptgruppe ist der eine Reiter (Zugang)', () => {
    const a = startReiterAuswahl(kategorien, ['bier'])
    expect(a.reiter.map(r => r.id)).toEqual(['kg'])
    expect(a.gruppen.map(g => g.pfad)).toEqual(['Kellner Getränke', 'Kellner Getränke › Bier'])
  })

  it('inaktive Warengruppen zählen nicht', () => {
    const a = startReiterAuswahl([k('a', 'A'), k('b', 'B', { aktiv: false })], [])
    expect(a.reiter.map(r => r.id)).toEqual(['a'])
  })
})
