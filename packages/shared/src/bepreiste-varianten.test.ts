import { describe, it, expect } from 'vitest'
import {
  findeBepreisteVarianten,
  istAkut,
  planeVariantenArtikel,
  ursprungDeaktivieren,
  variantenBezeichnung,
  variantenPreisCent,
  type VariantenArtikel,
  type VariantenGruppe,
} from './bepreiste-varianten.js'

// ---------------------------------------------------------------------------
// Testdaten: „Bier" 0,00 mit 0,33l (+4,00) / 0,5l (+5,00) und „Spritzer" 4,00 mit Muskateller (+0,50)
// ---------------------------------------------------------------------------

const artikelVorlage: VariantenArtikel = {
  id: 'a1', bezeichnung: 'Bier', preisBruttoCent: 0, kategorieId: 'k1', aktiv: true, optionenAbfrage: null,
}

const bierGruppe: VariantenGruppe = {
  id: 'g1', name: 'Variante (0,33l / 0,5l)', aktiv: true,
  modifikatoren: [
    { id: 'm1', name: '0,33l', aufschlagCent: 400, aktiv: true },
    { id: 'm2', name: '0,5l',  aufschlagCent: 500, aktiv: true },
  ],
}

const extras: VariantenGruppe = {
  id: 'g2', name: 'Extras', aktiv: true,
  modifikatoren: [{ id: 'm9', name: 'ohne Eis', aufschlagCent: 0, aktiv: true }],
}

const basis = (ueberschreiben: Partial<Parameters<typeof findeBepreisteVarianten>[0]> = {}) =>
  findeBepreisteVarianten({
    artikel:     [artikelVorlage],
    kategorien:  [{ id: 'k1', parentId: null, optionenAbfrage: null }],
    gruppen:     [bierGruppe, extras],
    zuweisungen: [{ artikelId: 'a1', gruppeId: 'g1' }, { artikelId: 'a1', gruppeId: 'g2' }],
    kassen:      [{ name: 'Bar', optionenAbfrage: false }],
    ...ueberschreiben,
  })

// ---------------------------------------------------------------------------
describe('findeBepreisteVarianten', () => {
  it('findet den Artikel mit seinen bepreisten Optionen', () => {
    const treffer = basis()
    expect(treffer).toHaveLength(1)
    expect(treffer[0]!.bezeichnung).toBe('Bier')
    expect(treffer[0]!.gruppen).toHaveLength(1)
    expect(treffer[0]!.gruppen[0]!.gruppeId).toBe('g1')
    expect(treffer[0]!.gruppen[0]!.optionen.map(o => o.name)).toEqual(['0,33l', '0,5l'])
  })

  it('lässt Gruppen ohne Aufschlag weg (Extras sind kein Preisproblem)', () => {
    expect(basis()[0]!.gruppen.map(g => g.gruppeId)).not.toContain('g2')
  })

  it('nennt die Kassen ohne Abfrage — dort wird jetzt falsch boniert', () => {
    const treffer = basis({ kassen: [
      { name: 'Bar',    optionenAbfrage: false },
      { name: 'Küche',  optionenAbfrage: true },
    ] })
    expect(treffer[0]!.kassenOhneAbfrage).toEqual(['Bar'])
    expect(istAkut(treffer[0]!)).toBe(true)
  })

  it('listet den Artikel auch, wenn überall gefragt wird — dann aber nicht akut', () => {
    const treffer = basis({ kassen: [{ name: 'Küche', optionenAbfrage: true }] })
    expect(treffer).toHaveLength(1)
    expect(treffer[0]!.kassenOhneAbfrage).toEqual([])
    expect(istAkut(treffer[0]!)).toBe(false)
  })

  it('beachtet die Rangfolge: Artikel „immer fragen" schlägt die abgeschaltete Kasse', () => {
    const treffer = basis({ artikel: [{ ...artikelVorlage, optionenAbfrage: true }] })
    expect(treffer[0]!.kassenOhneAbfrage).toEqual([])
  })

  it('beachtet die Warengruppe samt Vererbung an die Untergruppe', () => {
    const treffer = basis({
      artikel:    [{ ...artikelVorlage, kategorieId: 'k2' }],
      kategorien: [
        { id: 'k1', parentId: null, optionenAbfrage: false },
        { id: 'k2', parentId: 'k1', optionenAbfrage: null },
      ],
      kassen:     [{ name: 'Küche', optionenAbfrage: true }],
    })
    expect(treffer[0]!.kassenOhneAbfrage).toEqual(['Küche'])
  })

  it('übergeht inaktive Artikel, Gruppen und Optionen', () => {
    expect(basis({ artikel: [{ ...artikelVorlage, aktiv: false }] })).toEqual([])
    expect(basis({ gruppen: [{ ...bierGruppe, aktiv: false }] })).toEqual([])
    expect(basis({ gruppen: [{
      ...bierGruppe,
      modifikatoren: bierGruppe.modifikatoren.map(m => ({ ...m, aktiv: false })),
    }] })).toEqual([])
  })

  it('lässt erledigte Optionen heraus und die Gruppe verschwinden, wenn keine offen bleibt', () => {
    const eine = basis({ erledigt: [{ artikelId: 'a1', modifikatorId: 'm1' }] })
    expect(eine[0]!.gruppen[0]!.optionen.map(o => o.name)).toEqual(['0,5l'])

    expect(basis({ erledigt: [
      { artikelId: 'a1', modifikatorId: 'm1' },
      { artikelId: 'a1', modifikatorId: 'm2' },
    ] })).toEqual([])
  })

  it('zählt die weiteren Artikel an derselben geteilten Gruppe', () => {
    const treffer = basis({
      artikel: [artikelVorlage, { ...artikelVorlage, id: 'a2', bezeichnung: 'Radler' }],
      zuweisungen: [
        { artikelId: 'a1', gruppeId: 'g1' },
        { artikelId: 'a2', gruppeId: 'g1' },
      ],
    })
    expect(treffer).toHaveLength(2)
    expect(treffer.map(t => t.gruppen[0]!.weitereArtikel)).toEqual([1, 1])
  })

  it('zählt inaktive Artikel nicht als weitere Artikel', () => {
    const treffer = basis({
      artikel: [artikelVorlage, { ...artikelVorlage, id: 'a2', bezeichnung: 'Radler', aktiv: false }],
      zuweisungen: [
        { artikelId: 'a1', gruppeId: 'g1' },
        { artikelId: 'a2', gruppeId: 'g1' },
      ],
    })
    expect(treffer[0]!.gruppen[0]!.weitereArtikel).toBe(0)
  })

  it('sortiert akute Fälle nach oben, darunter alphabetisch', () => {
    const treffer = basis({
      artikel: [
        { ...artikelVorlage, id: 'a1', bezeichnung: 'Zwickl', optionenAbfrage: true },
        { ...artikelVorlage, id: 'a2', bezeichnung: 'Radler' },
        { ...artikelVorlage, id: 'a3', bezeichnung: 'Ale' },
      ],
      zuweisungen: ['a1', 'a2', 'a3'].map(artikelId => ({ artikelId, gruppeId: 'g1' })),
    })
    expect(treffer.map(t => t.bezeichnung)).toEqual(['Ale', 'Radler', 'Zwickl'])
  })

  it('ohne Kassen (Konfiguration nicht geladen) gilt „es wird gefragt"', () => {
    expect(basis({ kassen: [] })[0]!.kassenOhneAbfrage).toEqual([])
  })

  it('negative Aufschläge (Rabatt-Varianten) zählen auch', () => {
    const treffer = basis({ gruppen: [{
      ...bierGruppe,
      modifikatoren: [{ id: 'm1', name: 'Happy Hour', aufschlagCent: -100, aktiv: true }],
    }] })
    expect(treffer[0]!.gruppen[0]!.optionen[0]!.aufschlagCent).toBe(-100)
  })
})

// ---------------------------------------------------------------------------
describe('variantenBezeichnung', () => {
  it('hängt die Option an den Artikel', () => {
    expect(variantenBezeichnung('Bier', '0,5l')).toBe('Bier 0,5l')
  })

  it('lässt die Option allein, wenn der Artikelname schon darin steckt', () => {
    expect(variantenBezeichnung('Spritzer', 'Muskatellerspritzer')).toBe('Muskatellerspritzer')
    expect(variantenBezeichnung('Bier', 'Bier groß')).toBe('Bier groß')
  })

  it('achtet nicht auf Groß-/Kleinschreibung', () => {
    expect(variantenBezeichnung('SPRITZER', 'Muskatellerspritzer')).toBe('Muskatellerspritzer')
  })

  it('räumt Leerzeichen auf', () => {
    expect(variantenBezeichnung('  Bier ', ' 0,33l ')).toBe('Bier 0,33l')
  })
})

// ---------------------------------------------------------------------------
describe('variantenPreisCent', () => {
  it('addiert Basispreis und Aufschlag', () => {
    expect(variantenPreisCent(0, 500)).toBe(500)
    expect(variantenPreisCent(400, 50)).toBe(450)
  })

  it('fällt bei großem Abschlag nicht unter 0', () => {
    expect(variantenPreisCent(400, -500)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('planeVariantenArtikel', () => {
  const bier = { bezeichnung: 'Bier', preisBruttoCent: 0, kategorieId: 'k1' }
  const optionen = [
    { id: 'm1', name: '0,33l', aufschlagCent: 400 },
    { id: 'm2', name: '0,5l',  aufschlagCent: 500 },
  ]

  it('rechnet Bezeichnung und Preis je Option', () => {
    expect(planeVariantenArtikel(bier, optionen, [])).toEqual([
      { modifikatorId: 'm1', bezeichnung: 'Bier 0,33l', preisBruttoCent: 400, vorhanden: false },
      { modifikatorId: 'm2', bezeichnung: 'Bier 0,5l',  preisBruttoCent: 500, vorhanden: false },
    ])
  })

  it('erkennt einen gleichnamigen Artikel in derselben Warengruppe als vorhanden', () => {
    const plan = planeVariantenArtikel(bier, optionen, [{ bezeichnung: 'bier 0,5L', kategorieId: 'k1' }])
    expect(plan.map(p => p.vorhanden)).toEqual([false, true])
  })

  it('ein gleichnamiger Artikel in einer ANDEREN Warengruppe blockiert nicht', () => {
    const plan = planeVariantenArtikel(bier, optionen, [{ bezeichnung: 'Bier 0,5l', kategorieId: 'k9' }])
    expect(plan.map(p => p.vorhanden)).toEqual([false, false])
  })

  it('erkennt Doppelte innerhalb des Plans selbst', () => {
    const plan = planeVariantenArtikel(bier, [
      { id: 'm1', name: '0,5l', aufschlagCent: 500 },
      { id: 'm2', name: '0,5L', aufschlagCent: 500 },
    ], [])
    expect(plan.map(p => p.vorhanden)).toEqual([false, true])
  })

  it('Artikel ohne Warengruppe: nur andere Artikel ohne Warengruppe blockieren', () => {
    const ohne = { bezeichnung: 'Bier', preisBruttoCent: 0, kategorieId: null }
    expect(planeVariantenArtikel(ohne, optionen, [{ bezeichnung: 'Bier 0,5l', kategorieId: null }])
      .map(p => p.vorhanden)).toEqual([false, true])
    expect(planeVariantenArtikel(ohne, optionen, [{ bezeichnung: 'Bier 0,5l', kategorieId: 'k1' }])
      .map(p => p.vorhanden)).toEqual([false, false])
  })
})

// ---------------------------------------------------------------------------
describe('ursprungDeaktivieren', () => {
  it('ja bei Basispreis 0,00 und allem aufgelöst', () => {
    expect(ursprungDeaktivieren(0, true)).toBe(true)
  })

  it('nein solange noch Varianten offen sind', () => {
    expect(ursprungDeaktivieren(0, false)).toBe(false)
  })

  it('nein bei eigenem Preis — „Spritzer" 4,00 bleibt verkäuflich', () => {
    expect(ursprungDeaktivieren(400, true)).toBe(false)
  })
})
