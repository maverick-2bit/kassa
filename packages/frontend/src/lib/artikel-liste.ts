/**
 * artikel-liste.ts
 *
 * Sortierung + Filter der Artikelverwaltung (reine Funktionen, testbar).
 *
 * „standard" ist die Kassen-Reihenfolge: Warengruppen nach ihrer Reihenfolge,
 * darin die Artikel nach ihrer Reihenfolge. Nur in dieser Ansicht lassen sich
 * Artikel per ↑/↓ verschieben. Alle anderen Spalten sortieren auf- oder
 * absteigend; Gleichstände fallen auf die Standard-Reihenfolge zurück, leere
 * Werte (keine Warengruppe, keine Nummer, kein Lagerstand) stehen immer hinten.
 */

import { MWST_LABELS, type Artikel, type Kategorie } from '@kassa/shared'

export type ArtikelSortSpalte =
  | 'standard'
  | 'bezeichnung'
  | 'kategorie'
  | 'nummer'
  | 'mwst'
  | 'preis'
  | 'bestand'
  | 'favorit'
  | 'status'

export type SortRichtung = 'auf' | 'ab'

export interface ArtikelSortierung {
  spalte:   ArtikelSortSpalte
  richtung: SortRichtung
}

export const STANDARD_SORTIERUNG: ArtikelSortierung = { spalte: 'standard', richtung: 'auf' }

/** Warengruppen-Filter: alle, nur ohne Warengruppe oder eine bestimmte ID. */
export type WarengruppenFilter = 'alle' | 'ohne' | string

const text = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

/** Klick auf eine Spaltenüberschrift: neue Spalte aufsteigend, gleiche Spalte umdrehen. */
export function naechsteSortierung(aktuell: ArtikelSortierung, spalte: ArtikelSortSpalte): ArtikelSortierung {
  if (spalte === 'standard') return STANDARD_SORTIERUNG
  if (aktuell.spalte !== spalte) return { spalte, richtung: 'auf' }
  return { spalte, richtung: aktuell.richtung === 'auf' ? 'ab' : 'auf' }
}

export function sortiereArtikel(
  artikel:    readonly Artikel[],
  kategorien: readonly Kategorie[],
  sort:       ArtikelSortierung,
): Artikel[] {
  const katReihenfolge = new Map(kategorien.map(k => [k.id, k.reihenfolge]))
  const katName        = new Map(kategorien.map(k => [k.id, k.name]))

  const standard = (a: Artikel, b: Artikel): number => {
    const ka = a.kategorieId ? (katReihenfolge.get(a.kategorieId) ?? 9999) : 9999
    const kb = b.kategorieId ? (katReihenfolge.get(b.kategorieId) ?? 9999) : 9999
    if (ka !== kb) return ka - kb
    // Gleiche Reihenfolgezahl, verschiedene Warengruppen → nicht vermischen
    if (a.kategorieId !== b.kategorieId) {
      return text.compare(katName.get(a.kategorieId ?? '') ?? '', katName.get(b.kategorieId ?? '') ?? '')
    }
    if (a.reihenfolge !== b.reihenfolge) return a.reihenfolge - b.reihenfolge
    return text.compare(a.bezeichnung, b.bezeichnung)
  }

  /** Sortierschlüssel je Spalte; null = leer → immer ans Ende. */
  const schluessel = (a: Artikel): string | number | null => {
    switch (sort.spalte) {
      case 'bezeichnung': return a.bezeichnung
      case 'kategorie':   return a.kategorieId ? (katName.get(a.kategorieId) ?? null) : null
      case 'nummer':      return a.artikelnummer || null
      case 'mwst':        return MWST_LABELS[a.mwstSatz]
      case 'preis':       return a.preisBruttoCent
      // Ohne Lagerführung leer; mit Lagerführung, aber ohne Menge = unbegrenzt
      case 'bestand':     return a.lagerstandAktiv ? (a.lagerstandMenge ?? Number.POSITIVE_INFINITY) : null
      // Favoriten bzw. aktive Artikel zuerst bei „auf"
      case 'favorit':     return a.istFavorit ? 0 : 1
      case 'status':      return a.aktiv ? 0 : 1
      case 'standard':    return null
    }
  }

  const arr = [...artikel]
  if (sort.spalte === 'standard') return arr.sort(standard)

  const faktor = sort.richtung === 'auf' ? 1 : -1
  return arr.sort((a, b) => {
    const sa = schluessel(a)
    const sb = schluessel(b)
    if (sa === null || sb === null) {
      if (sa !== sb) return sa === null ? 1 : -1
      return standard(a, b)
    }
    const v = typeof sa === 'number' && typeof sb === 'number'
      ? (sa === sb ? 0 : sa < sb ? -1 : 1)
      : text.compare(String(sa), String(sb))
    return v !== 0 ? v * faktor : standard(a, b)
  })
}

export function filtereArtikel(
  artikel:     readonly Artikel[],
  warengruppe: WarengruppenFilter,
  suche:       string,
): Artikel[] {
  const s = suche.trim().toLocaleLowerCase('de')
  return artikel.filter(a => {
    if (warengruppe === 'ohne' && a.kategorieId) return false
    if (warengruppe !== 'alle' && warengruppe !== 'ohne' && a.kategorieId !== warengruppe) return false
    if (!s) return true
    return a.bezeichnung.toLocaleLowerCase('de').includes(s)
      || (a.artikelnummer ?? '').toLocaleLowerCase('de').includes(s)
  })
}
