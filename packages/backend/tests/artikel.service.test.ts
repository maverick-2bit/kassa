/**
 * Artikel-Service: welche Felder beim Anlegen und Bearbeiten wirklich geschrieben werden.
 *
 * Anlass: `lieferantId` wurde von Schema und Formular angenommen, vom Service aber nie geschrieben
 * (die Bestellliste kannte so nie einen Lieferanten), `mindestbestand` ging beim Anlegen verloren
 * (auch beim Excel-Import). Mock-DB mit Spionen auf INSERT/UPDATE/DELETE — die Persistenz selbst
 * prüft der Integrationstest `integration/artikel-felder.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import type { Db } from '../src/db/client.js'
import { artikel, artikelBestandteile, lieferanten } from '../src/db/schema.js'
import { aktualisiereArtikel, ArtikelError, erstelleArtikel } from '../src/services/artikel.service.js'

const MANDANT = '10000000-0000-0000-0000-000000000001'
const ARTIKEL = '11111111-1111-4111-8111-111111111111'
const LIEFERANT = '22222222-2222-4222-8222-222222222222'
const ROHSTOFF = '33333333-3333-4333-8333-333333333333'

/** Vollständige Artikelzeile (so liest toDto sie). */
const zeile = (extra: Record<string, unknown> = {}) => ({
  id: ARTIKEL, mandantId: MANDANT, bezeichnung: 'Espresso', preisBruttoCent: 350, mwstSatz: 'normal',
  artikelnummer: '0001', station: null, farbe: null, kategorieId: null, rasterPosition: null, aktiv: true,
  lagerstandAktiv: false, lagerstandMenge: null, mindestbestand: null, seriennummernAktiv: false,
  terminalSichtbar: null, istFavorit: false, reihenfolge: 0, favoritenReihenfolge: 0, bonierdruckerId: null,
  bonierBeiDirektverkauf: false, istBestandteil: false, lieferantId: null, bild: null,
  createdAt: new Date('2026-05-20T10:00:00Z'), updatedAt: new Date('2026-05-20T10:00:00Z'), ...extra,
})

interface Zustand {
  /** SELECT … FROM lieferanten (leer = unbekannter oder fremder Lieferant) */
  lieferant?: unknown[]
  /** SELECT mandant_id FROM artikel WHERE id = … (Mandant des bearbeiteten Artikels; leer = Artikel unbekannt) */
  artikelMandant?: unknown[]
  /** SELECT id FROM artikel WHERE id IN (…) AND mandant_id = … (Mandanten-Prüfung der Rezept-Bestandteile) */
  vorhandeneBestandteile?: unknown[]
  /** UPDATE artikel … RETURNING: false = keine Zeile getroffen */
  updateTrifft?: boolean
}

function mockDb(z: Zustand = {}) {
  const spy = {
    /** Werte aller INSERTs (Artikelzeile bzw. Array der Rezeptzeilen) */
    inserts: [] as unknown[],
    /** Werte aller UPDATE … SET */
    updates: [] as Record<string, unknown>[],
    /** Anzahl DELETEs (Rezept leeren) */
    deletes: 0,
    /** Anzahl Lieferanten-Prüfungen */
    lieferantAbfragen: 0,
  }
  const select = (felder?: Record<string, unknown>) => {
    let treffer: unknown[] = []
    const sel: Record<string, unknown> = {
      from: (tabelle: unknown) => {
        if (tabelle === lieferanten) {
          spy.lieferantAbfragen++
          treffer = z.lieferant ?? [{ id: LIEFERANT }]
        } else if (tabelle === artikel) {
          // zwei verschiedene Abfragen auf `artikel`: Mandant des Artikels (Feld mandantId) bzw. Bestandteil-Prüfung (Feld id)
          treffer = felder && 'mandantId' in felder
            ? (z.artikelMandant ?? [{ mandantId: MANDANT }])
            : (z.vorhandeneBestandteile ?? [])
        } else if (tabelle === artikelBestandteile) {
          treffer = []                                  // Rezept-Join beim Zurücklesen des DTO
        }
        return sel
      },
      innerJoin: () => sel, leftJoin: () => sel, where: () => sel,
      limit:   () => Promise.resolve(treffer),
      orderBy: () => Promise.resolve(treffer),
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(treffer).then(ok, err),
    }
    return sel
  }
  const db: Record<string, unknown> = {
    execute: () => Promise.resolve([{ naechste: 1 }]),
    select,
    insert: () => ({
      values: (werte: unknown) => {
        spy.inserts.push(werte)
        return {
          returning: () => Promise.resolve([zeile(werte as Record<string, unknown>)]),
          then: (ok: (v: unknown) => unknown) => Promise.resolve([]).then(ok),
        }
      },
    }),
    update: () => ({
      set: (werte: Record<string, unknown>) => {
        spy.updates.push(werte)
        return { where: () => ({ returning: () => Promise.resolve(z.updateTrifft === false ? [] : [zeile(werte)]) }) }
      },
    }),
    delete: () => ({ where: () => { spy.deletes++; return Promise.resolve([]) } }),
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { db: db as unknown as Db, spy }
}

const eingabe = (extra: Record<string, unknown> = {}) => ({
  mandantId: MANDANT, bezeichnung: 'Espresso', preisBruttoCent: 350, mwstSatz: 'normal' as const,
  lagerstandAktiv: false, lagerstandMenge: null, mindestbestand: null, seriennummernAktiv: false, istFavorit: false,
  bonierBeiDirektverkauf: false, istBestandteil: false, bestandteile: [], terminalSichtbar: null, ...extra,
})

describe('erstelleArtikel schreibt Mindestbestand und Lieferant', () => {
  it('beide Felder landen im INSERT', async () => {
    const { db, spy } = mockDb()
    await erstelleArtikel(db, eingabe({ lagerstandAktiv: true, lagerstandMenge: 12, mindestbestand: 3, lieferantId: LIEFERANT }))
    expect(spy.inserts[0]).toMatchObject({ mindestbestand: 3, lieferantId: LIEFERANT, lagerstandMenge: 12 })
    expect(spy.lieferantAbfragen).toBe(1)
  })

  it('ohne Angabe: null, und keine Lieferanten-Abfrage', async () => {
    const { db, spy } = mockDb()
    await erstelleArtikel(db, eingabe())
    expect(spy.inserts[0]).toMatchObject({ mindestbestand: null, lieferantId: null })
    expect(spy.lieferantAbfragen).toBe(0)
  })

  it('fremder oder unbekannter Lieferant → ArtikelError 400, es wird nichts geschrieben', async () => {
    const { db, spy } = mockDb({ lieferant: [] })
    const fehler = await erstelleArtikel(db, eingabe({ lieferantId: LIEFERANT })).catch(e => e)
    expect(fehler).toBeInstanceOf(ArtikelError)
    expect(fehler).toMatchObject({ httpStatus: 400, message: 'Lieferant nicht gefunden' })
    expect(spy.inserts).toHaveLength(0)
  })
})

describe('aktualisiereArtikel: jedes mitgeschickte Feld wird geschrieben', () => {
  it('Farbe (Hex), Lieferant, Mindestbestand, Rohstoff-Flag, Bonierbon, Seriennummern landen im UPDATE', async () => {
    const { db, spy } = mockDb()
    await aktualisiereArtikel(db, ARTIKEL, {
      farbe: '#336699', lieferantId: LIEFERANT, mindestbestand: 3, istBestandteil: true,
      bonierBeiDirektverkauf: true, seriennummernAktiv: true, lagerstandAktiv: true, lagerstandMenge: 12,
    })
    expect(spy.updates[0]).toMatchObject({
      farbe: '#336699', lieferantId: LIEFERANT, mindestbestand: 3, istBestandteil: true,
      bonierBeiDirektverkauf: true, seriennummernAktiv: true, lagerstandAktiv: true, lagerstandMenge: 12,
    })
  })

  it('der Lieferant wird gegen den Mandanten DES ARTIKELS geprüft — fremder Lieferant → 400, kein UPDATE', async () => {
    const { db, spy } = mockDb({ lieferant: [] })
    const fehler = await aktualisiereArtikel(db, ARTIKEL, { lieferantId: LIEFERANT }).catch(e => e)
    expect(fehler).toBeInstanceOf(ArtikelError)
    expect(fehler).toMatchObject({ httpStatus: 400, message: 'Lieferant nicht gefunden' })
    expect(spy.updates).toHaveLength(0)
  })

  it('lieferantId: null löst die Verknüpfung — ohne Lieferanten-Abfrage', async () => {
    const { db, spy } = mockDb()
    await aktualisiereArtikel(db, ARTIKEL, { lieferantId: null })
    expect(spy.updates[0]).toHaveProperty('lieferantId', null)
    expect(spy.lieferantAbfragen).toBe(0)
  })

  it('unbekannter Artikel → null (die Route antwortet 404), kein Folgefehler wegen des Lieferanten', async () => {
    const { db } = mockDb({ artikelMandant: [], updateTrifft: false })
    await expect(aktualisiereArtikel(db, ARTIKEL, { lieferantId: LIEFERANT })).resolves.toBeNull()
  })

  it('nicht mitgeschickte Felder bleiben unberührt (Farbe, Lieferant, Mindestbestand, Rohstoff-Flag, Terminal, Raster, Rezept)', async () => {
    const { db, spy } = mockDb()
    await aktualisiereArtikel(db, ARTIKEL, { bezeichnung: 'Doppelter Espresso' })
    const werte = spy.updates[0]!
    for (const feld of ['farbe', 'lieferantId', 'mindestbestand', 'istBestandteil', 'terminalSichtbar', 'rasterPosition']) {
      expect(werte, `${feld} darf ohne Angabe nicht überschrieben werden`).not.toHaveProperty(feld)
    }
    expect(spy.deletes).toBe(0)               // Rezept nicht angefasst
  })

  it('Rezept leeren: bestandteile [] löscht das alte Rezept und fügt nichts ein', async () => {
    const { db, spy } = mockDb()
    await aktualisiereArtikel(db, ARTIKEL, { bestandteile: [] })
    expect(spy.deletes).toBe(1)
    expect(spy.inserts).toHaveLength(0)
  })

  it('Rezept ersetzen: gleiche Bestandteile werden summiert, Selbstbezug und Menge ≤ 0 übersprungen', async () => {
    const { db, spy } = mockDb({ vorhandeneBestandteile: [{ id: ROHSTOFF }] })
    await aktualisiereArtikel(db, ARTIKEL, { bestandteile: [
      { bestandteilArtikelId: ROHSTOFF, menge: 2 },
      { bestandteilArtikelId: ROHSTOFF, menge: 3 },
      { bestandteilArtikelId: ARTIKEL,  menge: 1 },     // Selbstbezug
      { bestandteilArtikelId: ROHSTOFF, menge: 0 },     // Menge 0
    ] })
    expect(spy.deletes).toBe(1)
    expect(spy.inserts).toEqual([[
      { mandantId: MANDANT, verkaufsartikelId: ARTIKEL, bestandteilArtikelId: ROHSTOFF, menge: 5 },
    ]])
  })

  it('Rezept mit fremdem oder unbekanntem Bestandteil wird abgewiesen (Meldung unverändert), es wird nichts eingefügt', async () => {
    // Der HTTP-Status dieses Fehlers (400 statt 500) ist Sache des Branches fix/fachfehler-luecken — hier nur: abgewiesen
    const { db, spy } = mockDb({ vorhandeneBestandteile: [] })
    await expect(
      aktualisiereArtikel(db, ARTIKEL, { bestandteile: [{ bestandteilArtikelId: ROHSTOFF, menge: 1 }] }),
    ).rejects.toThrow('Mindestens ein Bestandteil-Artikel gehört nicht zum Mandanten')
    expect(spy.inserts).toHaveLength(0)
  })
})
