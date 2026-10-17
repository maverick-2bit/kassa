/**
 * Tests für das Auflösen bepreister Varianten (varianten.service).
 *
 * Geprüft wird die Orchestrierung, die ohne DB nicht zu sehen ist: WAS wird angelegt (Bezeichnung, Preis und
 * die geerbten Felder), wann wird die Optionsgruppe vom Artikel gelöst, wann der Ursprungsartikel
 * deaktiviert — und dass ein vorhandener Artikel nicht noch einmal entsteht.
 *
 * Die reine Rechnung (Bezeichnung, Preis, Doppelt-Erkennung) liegt in @kassa/shared und ist dort getestet.
 *
 * Die Fake-DB antwortet je TABELLE aus einer Warteschlange (nicht wie sonst global der Reihe nach) — sonst
 * müsste jeder Test die exakte Aufrufreihenfolge aller Selects kennen und bricht bei jeder Umstellung.
 */

import { describe, it, expect } from 'vitest'
import { loeseVariantenAuf, listeVariantenErledigt, nimmVarianteZurueck } from '../src/services/varianten.service.js'
import { ModifikatorError } from '../src/services/modifikator.service.js'
import {
  artikel,
  artikelModifikatorGruppen,
  artikelVarianteErledigt,
  modifikatorGruppen,
  modifikatoren,
} from '../src/db/schema.js'
import type { Db } from '../src/db/client.js'

const MANDANT = '10000000-0000-0000-0000-000000000001'
const BIER    = 'a0000000-0000-0000-0000-000000000001'
const GRUPPE  = 'g0000000-0000-0000-0000-000000000001'
const M_033   = 'm0000000-0000-0000-0000-000000000001'
const M_05    = 'm0000000-0000-0000-0000-000000000002'
const NEU     = 'n0000000-0000-0000-0000-000000000001'

type Row = Record<string, unknown>

/** Kurzname der Tabelle — Schlüssel der Warteschlangen und des Protokolls. */
function tabelle(t: unknown): string {
  if (t === artikel)                   return 'artikel'
  if (t === artikelModifikatorGruppen) return 'amg'
  if (t === artikelVarianteErledigt)   return 'ave'
  if (t === modifikatorGruppen)        return 'gruppen'
  if (t === modifikatoren)             return 'modifikatoren'
  return 'andere'
}

interface Protokoll {
  inserts:  { tabelle: string; rows: Row[] }[]
  updates:  { tabelle: string; werte: Row }[]
  deletes:  string[]
}

/**
 * Fake-DB: `selects` liefert je Tabelle eine Antwort nach der anderen (die letzte wird wiederholt, damit ein
 * zusätzlicher Lesezugriff den Test nicht sprengt). Alles Schreibende landet im Protokoll.
 */
function fakeDb(selects: Record<string, Row[][]>, naechsteNummer = '0042'): { db: Db; log: Protokoll } {
  const log: Protokoll = { inserts: [], updates: [], deletes: [] }
  const zeiger: Record<string, number> = {}

  const antwort = (t: unknown): Row[] => {
    const name  = tabelle(t)
    const liste = selects[name] ?? []
    const i     = zeiger[name] ?? 0
    zeiger[name] = i + 1
    return liste[Math.min(i, liste.length - 1)] ?? []
  }

  /** Objekt, das jede Drizzle-Kette schluckt und am Ende `rows` liefert. */
  const kette = (rows: () => Row[]): any => {
    const o: any = {}
    for (const m of ['where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy']) o[m] = () => o
    o.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, err)
    o.returning = () => Promise.resolve(rows())
    o.onConflictDoNothing = () => kette(rows)
    o.onConflictDoUpdate  = () => kette(rows)
    return o
  }

  const api = {
    select: () => ({ from: (t: unknown) => kette(() => antwort(t)) }),
    insert: (t: unknown) => ({
      values: (v: Row | Row[]) => {
        const rows = Array.isArray(v) ? v : [v]
        log.inserts.push({ tabelle: tabelle(t), rows })
        return kette(() => (tabelle(t) === 'artikel' ? [{ id: NEU }] : rows))
      },
    }),
    update: (t: unknown) => ({
      set: (werte: Row) => { log.updates.push({ tabelle: tabelle(t), werte }); return kette(() => []) },
    }),
    delete: (t: unknown) => { log.deletes.push(tabelle(t)); return kette(() => []) },
    execute: () => Promise.resolve([{ naechste: Number(naechsteNummer) }]),
  }

  const db = { ...api, transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db) }
  return { db: db as unknown as Db, log }
}

// ---------------------------------------------------------------------------
// Testdaten: „Bier" 0,00 mit „0,33l" (+4,00) und „0,5l" (+5,00)
// ---------------------------------------------------------------------------

const bierRow = (ueber: Row = {}): Row => ({
  id: BIER, mandantId: MANDANT, bezeichnung: 'Bier', preisBruttoCent: 0, mwstSatz: '20',
  artikelnummer: '0001', allergene: 'A,C', station: 'schank', farbe: 'amber', kategorieId: 'k1',
  rasterPosition: 3, aktiv: true, lagerstandAktiv: false, lagerstandMenge: null, mindestbestand: null,
  seriennummernAktiv: false, terminalSichtbar: null, optionenAbfrage: false, istFavorit: true,
  reihenfolge: 0, favoritenReihenfolge: 0, bonierdruckerId: 'd1', bonierBeiDirektverkauf: true,
  istBestandteil: false, lieferantId: 'l1', bild: null,
  createdAt: new Date(), updatedAt: new Date(), ...ueber,
})

const gruppeRow = (ueber: Row = {}): Row => ({
  id: GRUPPE, mandantId: MANDANT, name: 'Variante (0,33l / 0,5l)', typ: 'pflicht', maxAuswahl: null,
  jeAuswahlArtikel: true, reihenfolge: 0, aktiv: true, createdAt: new Date(), updatedAt: new Date(), ...ueber,
})

const modRow = (id: string, name: string, aufschlagCent: number, ueber: Row = {}): Row => ({
  id, mandantId: MANDANT, gruppeId: GRUPPE, name, aufschlagCent, reihenfolge: 0, aktiv: true,
  lagerstandMenge: null, createdAt: new Date(), ...ueber,
})

/** Standard-Antworten: Bier mit Gruppe und beiden Optionen, nichts erledigt, keine weiteren Artikel. */
const standard = (ueber: Partial<Record<string, Row[][]>> = {}): Record<string, Row[][]> => ({
  artikel:       [[bierRow()], [{ bezeichnung: 'Bier', kategorieId: 'k1' }]],
  gruppen:       [[gruppeRow()]],
  modifikatoren: [[modRow(M_033, '0,33l', 400), modRow(M_05, '0,5l', 500)]],
  amg:           [[{ gruppeId: GRUPPE }], [{ gruppeId: GRUPPE, reihenfolge: 0 }]],
  ave:           [[{ modifikatorId: M_033 }, { modifikatorId: M_05 }]],
  ...ueber,
})

// ---------------------------------------------------------------------------
describe('loeseVariantenAuf — eigene Artikel anlegen', () => {
  it('legt je Option einen Artikel mit Basispreis + Aufschlag an', async () => {
    const { db } = fakeDb(standard())
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033, M_05], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.angelegt).toEqual([
      { modifikatorId: M_033, artikelId: NEU, bezeichnung: 'Bier 0,33l', preisBruttoCent: 400 },
      { modifikatorId: M_05,  artikelId: NEU, bezeichnung: 'Bier 0,5l',  preisBruttoCent: 500 },
    ])
    expect(ergebnis.uebersprungen).toEqual([])
  })

  it('der neue Artikel erbt Warengruppe, MwSt, Station und Allergene', async () => {
    const { db, log } = fakeDb(standard())
    await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_05], verwerfen: [] }, MANDANT, db)

    const neu = log.inserts.find(i => i.tabelle === 'artikel')!.rows[0]!
    expect(neu).toMatchObject({
      bezeichnung: 'Bier 0,5l', preisBruttoCent: 500, mwstSatz: '20', kategorieId: 'k1',
      station: 'schank', allergene: 'A,C', farbe: 'amber', bonierdruckerId: 'd1',
      bonierBeiDirektverkauf: true, lieferantId: 'l1',
    })
  })

  it('der neue Artikel bekommt keine Rasterposition und keine Abfrage-Einstellung', async () => {
    const { db, log } = fakeDb(standard())
    await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_05], verwerfen: [] }, MANDANT, db)

    const neu = log.inserts.find(i => i.tabelle === 'artikel')!.rows[0]!
    // leer = hängt sich hinten ans Kassen-Raster an; die Abfrage-Einstellung des Ursprungs wäre sinnlos
    expect(neu.rasterPosition).toBeUndefined()
    expect(neu.optionenAbfrage).toBeUndefined()
    expect(neu.istFavorit).toBeUndefined()
  })

  it('legt einen vorhandenen Artikel nicht doppelt an, merkt ihn aber als erledigt', async () => {
    const { db, log } = fakeDb(standard({
      artikel: [[bierRow()], [{ bezeichnung: 'bier 0,5L', kategorieId: 'k1' }], [{ id: 'alt1' }]],
    }))
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_05], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.angelegt).toEqual([])
    expect(ergebnis.uebersprungen).toEqual([
      { modifikatorId: M_05, bezeichnung: 'Bier 0,5l', grund: expect.stringContaining('schon vorhanden') },
    ])
    expect(log.inserts.filter(i => i.tabelle === 'artikel')).toEqual([])
    expect(log.inserts.find(i => i.tabelle === 'ave')!.rows[0]).toMatchObject({ art: 'angelegt', artikelNeuId: 'alt1' })
  })

  it('hängt die übrigen Optionsgruppen des Ursprungs an den neuen Artikel', async () => {
    const { db, log } = fakeDb(standard({
      amg: [
        [{ gruppeId: GRUPPE }],
        [{ gruppeId: GRUPPE, reihenfolge: 0 }, { gruppeId: 'g-extras', reihenfolge: 1 }],
      ],
      // die Restgruppe „Extras" hat keine bepreiste Option → Ursprung gilt als fertig aufgelöst
      gruppen: [[gruppeRow()], [gruppeRow({ id: 'g-extras', name: 'Extras' })]],
      modifikatoren: [
        [modRow(M_033, '0,33l', 400), modRow(M_05, '0,5l', 500)],
        [modRow('m-eis', 'ohne Eis', 0, { gruppeId: 'g-extras' })],
      ],
    }))
    await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033, M_05], verwerfen: [] }, MANDANT, db)

    const zuweisung = log.inserts.find(i => i.tabelle === 'amg')!
    expect(zuweisung.rows).toEqual([{ artikelId: NEU, gruppeId: 'g-extras', reihenfolge: 0 }])
  })
})

// ---------------------------------------------------------------------------
describe('loeseVariantenAuf — verwerfen', () => {
  it('merkt die Entscheidung und löscht die Option NICHT (Gruppen sind geteilt)', async () => {
    const { db, log } = fakeDb(standard())
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [], verwerfen: [M_033, M_05] }, MANDANT, db)

    expect(ergebnis.verworfen).toBe(2)
    expect(log.inserts.filter(i => i.tabelle === 'artikel')).toEqual([])
    expect(log.deletes).not.toContain('modifikatoren')
    expect(log.inserts.filter(i => i.tabelle === 'ave').map(i => i.rows[0]!.art)).toEqual(['verworfen', 'verworfen'])
  })
})

// ---------------------------------------------------------------------------
describe('loeseVariantenAuf — Gruppe lösen und Ursprung deaktivieren', () => {
  it('löst die Gruppe vom Artikel, wenn keine bepreiste Option offen bleibt', async () => {
    const { db, log } = fakeDb(standard())
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033, M_05], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.gruppeGeloest).toBe(true)
    expect(log.deletes).toContain('amg')
  })

  it('lässt die Gruppe am Artikel, solange eine Option offen ist', async () => {
    const { db, log } = fakeDb(standard({ ave: [[{ modifikatorId: M_033 }]] }))
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.gruppeGeloest).toBe(false)
    expect(ergebnis.ursprungDeaktiviert).toBe(false)
    expect(log.deletes).not.toContain('amg')
  })

  it('deaktiviert den Ursprungsartikel bei Basispreis 0,00', async () => {
    const { db, log } = fakeDb(standard())
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033, M_05], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.ursprungDeaktiviert).toBe(true)
    expect(log.updates).toEqual([{ tabelle: 'artikel', werte: expect.objectContaining({ aktiv: false }) }])
  })

  it('lässt „Spritzer" 4,00 aktiv — der Artikel ist selbst verkäuflich', async () => {
    const { db, log } = fakeDb(standard({
      artikel: [[bierRow({ bezeichnung: 'Spritzer', preisBruttoCent: 400 })], [{ bezeichnung: 'Spritzer', kategorieId: 'k1' }]],
      modifikatoren: [[modRow(M_033, 'Muskatellerspritzer', 50)]],
      ave: [[{ modifikatorId: M_033 }]],
    }))
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.gruppeGeloest).toBe(true)
    expect(ergebnis.ursprungDeaktiviert).toBe(false)
    expect(log.updates).toEqual([])
    // Artikelname steckt schon in der Option → kein „Spritzer Muskatellerspritzer"
    expect(ergebnis.angelegt[0]).toMatchObject({ bezeichnung: 'Muskatellerspritzer', preisBruttoCent: 450 })
  })

  it('deaktiviert nicht, solange eine ANDERE bepreiste Gruppe am Artikel hängt', async () => {
    const { db, log } = fakeDb(standard({
      amg: [
        [{ gruppeId: GRUPPE }],
        [{ gruppeId: GRUPPE, reihenfolge: 0 }, { gruppeId: 'g-fass', reihenfolge: 1 }],
      ],
      gruppen: [[gruppeRow()], [gruppeRow({ id: 'g-fass', name: 'Fass' })]],
      modifikatoren: [
        [modRow(M_033, '0,33l', 400), modRow(M_05, '0,5l', 500)],
        [modRow('m-fass', '1l Krügel', 800, { gruppeId: 'g-fass' })],
      ],
    }))
    const ergebnis = await loeseVariantenAuf(BIER, { gruppeId: GRUPPE, anlegen: [M_033, M_05], verwerfen: [] }, MANDANT, db)

    expect(ergebnis.gruppeGeloest).toBe(true)
    expect(ergebnis.ursprungDeaktiviert).toBe(false)
    expect(log.updates).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('loeseVariantenAuf — Fehlerfälle', () => {
  const ruf = (db: Db, input = { gruppeId: GRUPPE, anlegen: [M_05], verwerfen: [] }) =>
    loeseVariantenAuf(BIER, input, MANDANT, db)

  it('404 wenn der Artikel nicht zum Mandanten gehört', async () => {
    const { db } = fakeDb(standard({ artikel: [[]] }))
    await expect(ruf(db)).rejects.toThrow(ModifikatorError)
    await expect(ruf(db)).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('404 wenn die Optionsgruppe nicht gefunden wird', async () => {
    const { db } = fakeDb(standard({ gruppen: [[]] }))
    await expect(ruf(db)).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('400 wenn die Gruppe nicht zu diesem Artikel gehört', async () => {
    const { db } = fakeDb(standard({ amg: [[]] }))
    await expect(ruf(db)).rejects.toMatchObject({ httpStatus: 400 })
  })

  it('400 wenn die Option nicht zu dieser Gruppe gehört', async () => {
    const { db } = fakeDb(standard())
    await expect(ruf(db, { gruppeId: GRUPPE, anlegen: ['x0000000-0000-0000-0000-000000000009'], verwerfen: [] }))
      .rejects.toMatchObject({ httpStatus: 400 })
  })

  it('400 wenn eine Option gleichzeitig angelegt und verworfen werden soll', async () => {
    const { db } = fakeDb(standard())
    await expect(ruf(db, { gruppeId: GRUPPE, anlegen: [M_05], verwerfen: [M_05] }))
      .rejects.toMatchObject({ httpStatus: 400 })
  })

  it('nichts wird angelegt, wenn die Prüfung scheitert', async () => {
    const { db, log } = fakeDb(standard({ amg: [[]] }))
    await expect(ruf(db)).rejects.toThrow()
    expect(log.inserts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('listeVariantenErledigt', () => {
  it('gibt die Entscheidungen des Mandanten zurück', async () => {
    const { db } = fakeDb({ ave: [[
      { artikelId: BIER, modifikatorId: M_033, art: 'angelegt',  artikelNeuId: NEU },
      { artikelId: BIER, modifikatorId: M_05,  art: 'verworfen', artikelNeuId: null },
    ]] })
    expect(await listeVariantenErledigt(MANDANT, db)).toEqual([
      { artikelId: BIER, modifikatorId: M_033, art: 'angelegt',  artikelNeuId: NEU },
      { artikelId: BIER, modifikatorId: M_05,  art: 'verworfen', artikelNeuId: null },
    ])
  })

  it('unbekannte Werte in „art" gelten als verworfen (kein Datenmüll nach außen)', async () => {
    const { db } = fakeDb({ ave: [[{ artikelId: BIER, modifikatorId: M_05, art: 'quatsch', artikelNeuId: null }]] })
    expect((await listeVariantenErledigt(MANDANT, db))[0]!.art).toBe('verworfen')
  })
})

// ---------------------------------------------------------------------------
describe('nimmVarianteZurueck', () => {
  it('löscht die Entscheidung und hängt die Gruppe wieder an den Artikel', async () => {
    const { db, log } = fakeDb({
      artikel:       [[{ id: BIER, aktiv: true, preisBruttoCent: 0 }]],
      modifikatoren: [[{ gruppeId: GRUPPE }]],
    })
    await nimmVarianteZurueck(BIER, M_05, MANDANT, db)

    expect(log.deletes).toContain('ave')
    expect(log.inserts).toEqual([{ tabelle: 'amg', rows: [{ artikelId: BIER, gruppeId: GRUPPE, reihenfolge: 0 }] }])
  })

  it('aktiviert den beim Auflösen deaktivierten Artikel wieder — sonst bleibt der Fall unsichtbar', async () => {
    const { db, log } = fakeDb({
      artikel:       [[{ id: BIER, aktiv: false, preisBruttoCent: 0 }]],
      modifikatoren: [[{ gruppeId: GRUPPE }]],
    })
    await nimmVarianteZurueck(BIER, M_05, MANDANT, db)

    expect(log.updates).toEqual([{ tabelle: 'artikel', werte: expect.objectContaining({ aktiv: true }) }])
  })

  it('rührt einen deaktivierten Artikel MIT eigenem Preis nicht an (den hat der Benutzer selbst abgedreht)', async () => {
    const { db, log } = fakeDb({
      artikel:       [[{ id: BIER, aktiv: false, preisBruttoCent: 400 }]],
      modifikatoren: [[{ gruppeId: GRUPPE }]],
    })
    await nimmVarianteZurueck(BIER, M_05, MANDANT, db)

    expect(log.updates).toEqual([])
  })

  it('404 wenn der Artikel nicht zum Mandanten gehört', async () => {
    const { db } = fakeDb({ artikel: [[]] })
    await expect(nimmVarianteZurueck(BIER, M_05, MANDANT, db)).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('404 wenn die Option nicht zum Mandanten gehört', async () => {
    const { db } = fakeDb({ artikel: [[{ id: BIER }]], modifikatoren: [[]] })
    await expect(nimmVarianteZurueck(BIER, M_05, MANDANT, db)).rejects.toMatchObject({ httpStatus: 404 })
  })
})
