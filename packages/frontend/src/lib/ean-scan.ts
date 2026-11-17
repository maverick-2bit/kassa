/**
 * ean-scan.ts — Barcode-Scanner an der Kasse (reine Logik, testbar).
 *
 * Handscanner arbeiten als Tastatur: sie „tippen" die Ziffern sehr schnell und schicken Enter.
 * Zwei Wege führen zur Buchung:
 *  - Scan ins Suchfeld der Artikelwahl (Enter mit einer gültigen EAN im Feld);
 *  - Scan ohne Fokus in einem Eingabefeld: `ScanPuffer` sammelt die Ziffern, solange sie schnell
 *    hintereinander kommen, und liefert bei Enter die EAN. Eine langsam getippte Folge zählt nicht
 *    (Abstand > maxAbstandMs setzt den Puffer zurück), damit Tastendrücke nie zufällig buchen.
 */

import { eanSchluessel, istGueltigeEan, type Artikel } from '@kassa/shared'

/** Artikel zur gescannten EAN (Vergleich über den GTIN-14-Schlüssel: UPC-A 12- oder 13-stellig). */
export function findeNachEan<A extends Pick<Artikel, 'ean'>>(artikel: readonly A[], code: string): A | undefined {
  const c = code.trim()
  if (!istGueltigeEan(c)) return undefined
  const schluessel = eanSchluessel(c)
  return artikel.find(a => !!a.ean && eanSchluessel(a.ean) === schluessel)
}

export class ScanPuffer {
  private ziffern = ''
  private letzte = Number.NEGATIVE_INFINITY

  constructor(private readonly maxAbstandMs = 80) {}

  /**
   * Eine Taste verarbeiten. Liefert die EAN, wenn Enter eine gültige, schnell gescannte EAN abschließt;
   * sonst null. `zeitMs` = Zeitstempel des Tastendrucks (event.timeStamp).
   */
  taste(key: string, zeitMs: number): string | null {
    const zuSpaet = zeitMs - this.letzte > this.maxAbstandMs
    this.letzte = zeitMs
    if (key === 'Enter') {
      const code = zuSpaet ? '' : this.ziffern
      this.ziffern = ''
      return istGueltigeEan(code) ? code : null
    }
    if (/^\d$/.test(key)) {
      // Zu lange Folgen (kein EAN-Format) verwirft istGueltigeEan bei Enter
      this.ziffern = zuSpaet ? key : this.ziffern + key
      return null
    }
    this.ziffern = ''
    return null
  }
}
