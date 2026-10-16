/**
 * artikel-reiter.ts
 *
 * Reiter der Artikelwahl an der Kasse (Direktverkauf + Tisch).
 *
 * Es gibt keinen „Alle"-Reiter mehr — er zeigte auch Artikel aus Warengruppen,
 * die der Kasse gar nicht zugeordnet sind. Reiter sind: ⭐ Favoriten, die an
 * der Kasse sichtbaren Warengruppen und — nur wenn die Kasse alle Warengruppen
 * zeigt — „Sonstige" für Artikel ohne (aktive) Warengruppe.
 *
 * Welcher Reiter beim Öffnen aktiv ist, stellt die Kasse selbst ein (Einstellungen →
 * Kassen & Drucker bzw. POS-Konfiguration: Favoriten oder eine Warengruppe); hat sie
 * nur EINE Warengruppe, öffnet die sich von selbst. Passt die Einstellung nicht
 * (keine Favoriten, Warengruppe ausgeblendet), greift der nächste sinnvolle Reiter.
 */

import { artikelErlaubt, baueKassenRaster, istErreichbar, type Artikel, type KassenAnordnungEintrag, type Kategorie, type RasterZelle, type SichtbarkeitsMengen } from '@kassa/shared'
import { sichtbarkeitsMengen, untergruppenVon, wurzelgruppen } from './kategorie-baum'

/**
 * Aktive Warengruppen in Kassen-Reihenfolge, die an der Kasse ERREICHBAR sind: die ausdrücklich gewählten und
 * die Gruppen, die nur als Zugang zu einer gewählten Untergruppe dienen (ohne Einschränkung alle).
 * Jede Gruppe wird einzeln gewählt — Untergruppen einer gewählten Gruppe kommen NICHT automatisch dazu.
 */
export function sichtbareWarengruppen(
  kategorien: readonly Kategorie[],
  mengen: SichtbarkeitsMengen,
): Kategorie[] {
  const sorted = kategorien
    .filter(k => k.aktiv)
    .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
  return mengen.alle ? sorted : sorted.filter(k => istErreichbar(mengen, k.id))
}

// Eine Definition für alle Verbraucher (shared): Kasse/Tisch, Favoriten-Auswahl, Kellner-App
export { artikelErlaubt }

/** Artikel, die an dieser Kasse überhaupt vorkommen dürfen (siehe artikelErlaubt: nur ausdrücklich gewählte Gruppen). */
export function artikelDerKasse(
  artikel: readonly Artikel[],
  mengen: SichtbarkeitsMengen,
): Artikel[] {
  return artikel.filter(a => artikelErlaubt(a, mengen))
}

/** Was die Artikelwahl einer Kasse zeigt: Reiter, Kacheln und Artikel nach der Sichtbarkeits-Liste der Kasse. */
export interface KassenAnsicht {
  mengen:  SichtbarkeitsMengen
  /** Aktive, erreichbare Gruppen (gewählt oder nur Zugang) in Kassen-Reihenfolge — Reiter UND Untergruppen-Kacheln */
  gruppen: Kategorie[]
  /** Reiter = die Hauptgruppen unter den erreichbaren Gruppen */
  reiter:  Kategorie[]
  /** Verkaufsartikel dieser Kasse: nur aus ausdrücklich gewählten Gruppen, ohne Rohstoffe/Bestandteile */
  artikel: Artikel[]
}

export function kassenAnsicht(
  kategorien: readonly Kategorie[],
  artikel: readonly Artikel[],
  sichtbareKategorieIds: readonly string[] | undefined,
): KassenAnsicht {
  const mengen  = sichtbarkeitsMengen(kategorien, sichtbareKategorieIds)
  const gruppen = sichtbareWarengruppen(kategorien, mengen)
  return {
    mengen,
    gruppen,
    reiter:  wurzelgruppen(gruppen),
    artikel: artikelDerKasse(artikel.filter(a => !a.istBestandteil), mengen),
  }
}

/**
 * Zellen des Rasters einer Gruppe: zuerst die Untergruppen-Kacheln (nur erreichbare — nicht gewählte
 * Geschwister-Untergruppen fehlen), danach die EIGENEN Artikel der Gruppe an ihrer Raster-Position — mit der
 * eigenen Anordnung dieser Kasse (`anordnung`, Zeilen aus kasse_artikel_layout), sonst im Standard-Layout.
 * Eine Gruppe, die nur als Zugang sichtbar ist, hat keine eigenen Artikel (sie sind in `ansicht.artikel` nicht
 * enthalten): auch eine früher gespeicherte Anordnung erzeugt dort keine Leerfelder (Zeilen zu Artikeln, die nicht
 * in der Liste stehen, zählen nicht).
 */
export function gruppenRaster(
  ansicht: KassenAnsicht,
  gruppeId: string,
  anordnung?: readonly KassenAnordnungEintrag[] | null,
): RasterZelle<Kategorie, Artikel>[] {
  return baueKassenRaster(
    untergruppenVon(ansicht.gruppen, gruppeId),
    ansicht.artikel.filter(a => a.kategorieId === gruppeId),
    anordnung,
  )
}

// Start-Reiter (Favoriten / Warengruppe / die einzige Warengruppe): EINE Definition in @kassa/shared
// (start-reiter.ts) für Kasse, Tisch und Kellner-App — hier nur unter den gewohnten Namen erreichbar.
export { FAVORITEN_TAB_ID, SONSTIGE_TAB_ID, einzigeWarengruppe, reiterGueltig, startReiter } from '@kassa/shared'
export type { ReiterLage } from '@kassa/shared'
