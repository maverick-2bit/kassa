/**
 * Bestellvorschlag als Tabelle — eine Quelle für CSV-Export, PDF und Druck (Artikel & Lager → Bestellliste).
 */

import type { BestellvorschlagZeile } from '@kassa/shared'

export interface ExportZeile extends BestellvorschlagZeile {
  /** Tatsächlich zu bestellen (Vorschlag oder von Hand geändert) */
  bestellmenge: number
}

const zahl = (n: number): string => n.toLocaleString('de-AT', { maximumFractionDigits: 2 })
const euro = (cent: number): string => (cent / 100).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Erste Zeile = Überschriften. Sortiert nach Lieferant, dann Artikel. */
export function bestellvorschlagTabelle(
  zeilen: ExportZeile[],
  lieferantName: (id: string | null) => string,
  tage: number,
): string[][] {
  const kopf = [
    'Lieferant', 'Art.-Nr. Lieferant', 'Artikel', 'Bestand', 'Unterwegs', `Verbrauch ${tage} T`, 'Ø/Tag',
    'Reicht (Tage)', 'Mindest', 'Vorschlag', 'Bestellen', 'EK netto', 'EK gesamt',
  ]
  const sortiert = [...zeilen].sort((a, b) =>
    lieferantName(a.lieferantId).localeCompare(lieferantName(b.lieferantId), 'de') || a.bezeichnung.localeCompare(b.bezeichnung, 'de'))
  return [kopf, ...sortiert.map(z => [
    lieferantName(z.lieferantId),
    z.lieferantenArtikelnummer ?? '',
    z.bezeichnung,
    zahl(z.bestand),
    zahl(z.unterwegs),
    zahl(z.verbrauch),
    zahl(z.verbrauchProTag),
    z.reichtTage === null ? '–' : zahl(z.reichtTage),
    z.mindestbestand === null ? '–' : zahl(z.mindestbestand),
    zahl(z.vorschlag),
    zahl(z.bestellmenge),
    z.einkaufspreisCent === null ? '' : euro(z.einkaufspreisCent),
    z.einkaufspreisCent === null ? '' : euro(z.einkaufspreisCent * z.bestellmenge),
  ])]
}

/** Lagerstandsliste mit erwarteter Reichweite. Erste Zeile = Überschriften, Reihenfolge wie übergeben. */
export function reichweiteTabelle(
  zeilen: { bezeichnung: string; artikelnummer: string | null; bestand: number; mindestbestand: number | null; verbrauch: number;
            verbrauchProTag: number; reichtTageBestand: number | null; unterwegs: number; reichtTage: number | null }[],
  tage: number,
): string[][] {
  return [
    ['Artikel', 'Art.-Nr.', 'Lagerstand', 'Mindest', `Verbrauch ${tage} T`, 'Ø/Tag', 'Reicht (Tage)', 'Unterwegs', 'Reicht mit Bestellung'],
    ...zeilen.map(z => [
      z.bezeichnung, z.artikelnummer ?? '', zahl(z.bestand), z.mindestbestand === null ? '–' : zahl(z.mindestbestand),
      zahl(z.verbrauch), zahl(z.verbrauchProTag), z.reichtTageBestand === null ? '–' : zahl(z.reichtTageBestand),
      zahl(z.unterwegs), z.reichtTage === null ? '–' : zahl(z.reichtTage),
    ]),
  ]
}

/** CSV für Excel (Semikolon, BOM, CRLF); Felder mit ; " oder Zeilenumbruch in Anführungszeichen */
export function alsCsv(tabelle: string[][]): string {
  const feld = (s: string) => /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  return '﻿' + tabelle.map(z => z.map(feld).join(';')).join('\r\n') + '\r\n'
}

export function ladeCsvHerunter(csv: string, dateiname: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
