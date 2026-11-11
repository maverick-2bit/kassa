/**
 * „Schon erledigt" in der Ansicht Bepreiste Varianten: aus den Erledigt-Einträgen werden lesbare Zeilen.
 * Wichtig sind die Randfälle — deaktivierter Ursprungsartikel (Rücknahme muss dort erreichbar bleiben),
 * schon gelöschter Folge-Artikel und verschwundene Option.
 */

import { describe, it, expect } from 'vitest'
import type { ModifikatorGruppe, VarianteErledigt } from '@kassa/shared'
import { baueErledigtZeilen } from './BepreisteVariantenAnsicht'

const GRUPPE = {
  id: 'g1', name: 'Variante (0,33l / 0,5l)',
  modifikatoren: [
    { id: 'm33', gruppeId: 'g1', name: '0,33l', aufschlagCent: 400, reihenfolge: 0, aktiv: true, lagerstandMenge: null, createdAt: '' },
    { id: 'm50', gruppeId: 'g1', name: '0,5l',  aufschlagCent: 500, reihenfolge: 1, aktiv: true, lagerstandMenge: null, createdAt: '' },
  ],
} as unknown as ModifikatorGruppe

const artikel = (id: string, bezeichnung: string, aktiv: boolean, preisBruttoCent: number) =>
  ({ id, bezeichnung, aktiv, preisBruttoCent })

const BIER_AKTIV   = artikel('a-bier', 'Bier', true, 0)
const BIER_INAKTIV = artikel('a-bier', 'Bier', false, 0)
const BIER_050     = artikel('a-bier50', 'Bier 0,5l', true, 500)

const ANGELEGT:   VarianteErledigt = { artikelId: 'a-bier', modifikatorId: 'm50', art: 'angelegt',  artikelNeuId: 'a-bier50' }
const VERWORFEN:  VarianteErledigt = { artikelId: 'a-bier', modifikatorId: 'm33', art: 'verworfen', artikelNeuId: null }

/** Genau eine Zeile erwartet */
function eine(...args: Parameters<typeof baueErledigtZeilen>) {
  const zeilen = baueErledigtZeilen(...args)
  expect(zeilen).toHaveLength(1)
  return zeilen[0]!
}

describe('baueErledigtZeilen', () => {
  it('angelegt: nennt den neuen Artikel und weist darauf hin, dass er bestehen bleibt', () => {
    const z = eine([ANGELEGT], [GRUPPE], [BIER_AKTIV, BIER_050])
    expect(z.artikelName).toBe('Bier')
    expect(z.optionName).toBe('0,5l')
    expect(z.ergebnis).toBe('eigener Artikel: Bier 0,5l')
    expect(z.gruppeName).toBe('Variante (0,33l / 0,5l)')
    expect(z.hinweise).toEqual(['Der Artikel „Bier 0,5l" bleibt bestehen.'])
    expect(z.nichtMehrDa).toBe(false)
    expect(z.wirdAktiv).toBe(false)
  })

  it('verworfen: kein Hinweis auf einen Artikel', () => {
    const z = eine([VERWORFEN], [GRUPPE], [BIER_AKTIV])
    expect(z.ergebnis).toBe('verworfen')
    expect(z.hinweise).toEqual([])
  })

  it('deaktivierter Ursprungsartikel mit Basispreis 0,00 steht trotzdem da und wird bei der Rücknahme wieder aktiv', () => {
    const z = eine([VERWORFEN], [GRUPPE], [BIER_INAKTIV])
    expect(z.deaktiviert).toBe(true)
    expect(z.wirdAktiv).toBe(true)
    expect(z.nichtMehrDa).toBe(false)
    expect(z.hinweise).toEqual(['„Bier" wird wieder aktiviert.'])
  })

  it('deaktivierter Artikel mit Preis > 0 wird nicht „wieder aktiviert" (hat das Backend nicht deaktiviert)', () => {
    const z = eine([VERWORFEN], [GRUPPE], [artikel('a-bier', 'Spritzer', false, 400)])
    expect(z.deaktiviert).toBe(true)
    expect(z.wirdAktiv).toBe(false)
  })

  it('Folge-Artikel inzwischen gelöscht: sagt das und verspricht nichts', () => {
    const z = eine([ANGELEGT], [GRUPPE], [BIER_AKTIV])
    expect(z.ergebnis).toContain('inzwischen nicht mehr vorhanden')
    expect(z.hinweise).toEqual([])
  })

  it('Option oder Artikel verschwunden: Zeile bleibt sichtbar, Rücknahme gesperrt', () => {
    const ohneOption = eine([ANGELEGT], [], [BIER_AKTIV, BIER_050])
    expect(ohneOption.optionName).toBe('Option nicht mehr vorhanden')
    expect(ohneOption.nichtMehrDa).toBe(true)

    const ohneArtikel = eine([VERWORFEN], [GRUPPE], [])
    expect(ohneArtikel.artikelName).toBe('Artikel nicht mehr vorhanden')
    expect(ohneArtikel.nichtMehrDa).toBe(true)
  })

  it('sortiert nach Artikel, dann Option', () => {
    const zeilen = baueErledigtZeilen(
      [ANGELEGT, VERWORFEN, { artikelId: 'a-aperol', modifikatorId: 'm33', art: 'verworfen', artikelNeuId: null }],
      [GRUPPE],
      [BIER_AKTIV, BIER_050, artikel('a-aperol', 'Aperol', true, 0)],
    )
    expect(zeilen.map(z => `${z.artikelName}|${z.optionName}`)).toEqual(['Aperol|0,33l', 'Bier|0,33l', 'Bier|0,5l'])
  })

  it('Aufschlag wird formatiert', () => {
    const z = eine([ANGELEGT], [GRUPPE], [BIER_AKTIV, BIER_050])
    expect(z.aufschlag).toMatch(/^\+.*5,00/)
  })
})
