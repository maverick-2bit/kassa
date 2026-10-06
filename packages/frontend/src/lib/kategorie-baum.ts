/**
 * kategorie-baum.ts — Untergruppen-Baum der Warengruppen (kategorien.parentId).
 *
 * Die reine Logik liegt in @kassa/shared (kategorie-baum.ts), damit auch Kellner-App
 * und Server (Gast-/Terminal-Karte, Optionen-Import) dieselbe Auslegung benutzen.
 * Hier die Frontend-Sicht:
 *
 *  - Hauptgruppen = Reiter, Untergruppen = Kacheln IN der Gruppe (`wurzelgruppen`, `untergruppenVon`)
 *  - `reihenfolge` = Position unter Geschwistern, NIE ein globaler Index
 *  - mehrere Gruppen dürfen gleich heißen (z. B. „Alkoholfrei" unter drei Elterngruppen):
 *      `baumFlach`           Baumreihenfolge mit Einrückungstiefe — für Listen, Matrizen, Auswahlfelder
 *      `kategoriePfad`       „Atriumbar › Alkoholfrei" — Beschriftung in <select>-Optionen und Tooltips
 *      `kategorieAnzeigeName` Name, wenn im Mandanten eindeutig, sonst voller Pfad — für Spalten und Chips
 *      `loeseKategorieAuf`   Excel/Import: Name ODER Pfad → genau eine Gruppe, sonst „mehrdeutig"
 */

export {
  wurzelgruppen,
  untergruppenVon,
  geschwisterVon,
  nachkommenIds,
  pfadIds,
  wurzelIdVon,
  sichtbarkeitsMengen,
  istErreichbar,
  sichtbareGruppenFlach,
  baumFlach,
  KATEGORIE_PFAD_TRENNER,
  kategoriePfadNamen,
  kategoriePfad,
  kategorieAnzeigeNamen,
  kategorieAnzeigeName,
  normalisiereKategoriePfad,
  kategoriePfadNormalisiert,
  loeseKategorieAuf,
  kategorieSchluessel,
} from '@kassa/shared'
export type { KategorieAufloesung, SichtbarkeitsMengen } from '@kassa/shared'
