/**
 * artikel-import-duplikate.ts
 *
 * Erkennt beim Artikel-Import Zeilen, deren Artikel es in derselben Warengruppe
 * schon gibt — im Artikelstamm (auch deaktiviert) oder weiter oben in derselben
 * Datei. Gleich = gleiche Bezeichnung (ohne Groß-/Kleinschreibung und
 * Mehrfach-Leerzeichen) in derselben Warengruppe; „keine Warengruppe" zählt als
 * eigene Gruppe.
 *
 * Das Import-Modal fragt je Treffer, was passieren soll (Standard: überspringen).
 */

import type { Artikel, ArtikelUpdate, ArtikelInput, Kategorie } from '@kassa/shared'

export type DuplikatAktion = 'ueberspringen' | 'aktualisieren' | 'neu'

export interface ImportZeileKurz {
  zeile:       number
  bezeichnung: string
  /** Gewählter Warengruppen-Name ('' = keine). */
  kategorie:   string
}

export interface Duplikat {
  /** Vorhandener Artikel derselben Warengruppe (aktive werden bevorzugt). */
  vorhanden?:  Artikel
  /** Frühere Zeile derselben Datei mit demselben Artikel. */
  dateiZeile?: number
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')
const schluessel = (bezeichnung: string, kategorie: string) => `${norm(kategorie)}\u0000${norm(bezeichnung)}`

export function findeDuplikate(
  zeilen:     readonly ImportZeileKurz[],
  vorhandene: readonly Artikel[],
  kategorien: readonly Kategorie[],
): Map<number, Duplikat> {
  const katName = new Map(kategorien.map(k => [k.id, k.name]))

  const bestand = new Map<string, Artikel>()
  for (const a of vorhandene) {
    // Artikel einer unbekannten Warengruppe lassen sich keinem Namen zuordnen
    const kat = a.kategorieId ? katName.get(a.kategorieId) : ''
    if (kat === undefined) continue
    const k = schluessel(a.bezeichnung, kat)
    const bisher = bestand.get(k)
    if (!bisher || (!bisher.aktiv && a.aktiv)) bestand.set(k, a)
  }

  const ergebnis   = new Map<number, Duplikat>()
  const ersteZeile = new Map<string, number>()
  for (const z of zeilen) {
    const k = schluessel(z.bezeichnung, z.kategorie)
    const vorhanden  = bestand.get(k)
    const dateiZeile = ersteZeile.get(k)
    if (dateiZeile === undefined) ersteZeile.set(k, z.zeile)
    if (vorhanden || dateiZeile !== undefined) {
      ergebnis.set(z.zeile, {
        ...(vorhanden ? { vorhanden } : {}),
        ...(dateiZeile !== undefined ? { dateiZeile } : {}),
      })
    }
  }
  return ergebnis
}

/**
 * Was „aktualisieren" am vorhandenen Artikel ändert: Preis, MwSt, KDS-Station,
 * Lagerführung + Mindestbestand aus der Datei, und ein deaktivierter Artikel
 * wird wieder aktiv. Die Lagermenge wird nur gesetzt, wenn der Artikel bisher
 * keinen Lagerstand führte — eine laufende Menge überschreibt der Import nicht.
 */
export function aktualisierungAusImport(
  vorhanden: Artikel,
  daten:     Omit<ArtikelInput, 'mandantId'>,
): ArtikelUpdate {
  return {
    preisBruttoCent: daten.preisBruttoCent,
    mwstSatz:        daten.mwstSatz,
    station:         daten.station ?? null,
    lagerstandAktiv: daten.lagerstandAktiv,
    mindestbestand:  daten.mindestbestand ?? null,
    ...(!vorhanden.lagerstandAktiv && daten.lagerstandAktiv
      ? { lagerstandMenge: daten.lagerstandMenge ?? null }
      : {}),
    ...(vorhanden.aktiv ? {} : { aktiv: true }),
  }
}
