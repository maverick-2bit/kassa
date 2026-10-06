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
 * Welcher Reiter beim Öffnen aktiv ist, stellt die POS-Konfiguration je Kasse
 * ein (Favoriten oder eine Warengruppe); passt die Einstellung nicht (keine
 * Favoriten, Warengruppe ausgeblendet), greift der nächste sinnvolle Reiter.
 */

import { artikelErlaubt, baueRaster, istErreichbar, type Artikel, type Kategorie, type RasterZelle, type SichtbarkeitsMengen } from '@kassa/shared'
import { sichtbarkeitsMengen, untergruppenVon, wurzelgruppen } from './kategorie-baum'

export const FAVORITEN_TAB_ID = '__favoriten__'
export const SONSTIGE_TAB_ID  = '__sonstige__'

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
 * Geschwister-Untergruppen fehlen), danach die EIGENEN Artikel der Gruppe an ihrer Raster-Position. Eine Gruppe,
 * die nur als Zugang sichtbar ist, hat keine eigenen Artikel (sie sind in `ansicht.artikel` nicht enthalten).
 */
export function gruppenRaster(ansicht: KassenAnsicht, gruppeId: string): RasterZelle<Kategorie, Artikel>[] {
  return baueRaster(
    untergruppenVon(ansicht.gruppen, gruppeId),
    ansicht.artikel.filter(a => a.kategorieId === gruppeId),
  )
}

export interface ReiterLage {
  hatFavoriten: boolean
  hatSonstige:  boolean
  /** Warengruppen-Reiter in Anzeige-Reihenfolge */
  kategorieIds: readonly string[]
  /** Davon die mit mindestens einem Artikel */
  kategorieIdsMitArtikeln: readonly string[]
}

export function reiterGueltig(tab: string | null | undefined, lage: ReiterLage): tab is string {
  if (!tab) return false
  if (tab === FAVORITEN_TAB_ID) return lage.hatFavoriten
  if (tab === SONSTIGE_TAB_ID)  return lage.hatSonstige
  return lage.kategorieIds.includes(tab)
}

/**
 * Start-Reiter: ausdrücklich gewünschter (z. B. ?tab=favoriten) → Einstellung
 * der Kasse → Ersatz. „Erste Warengruppe" (startKategorieId null) meint die
 * erste Warengruppe mit Artikeln, Favoriten kommen dann erst danach.
 */
export function startReiter(
  lage: ReiterLage,
  einstellung: { startFavoriten?: boolean | undefined; startKategorieId?: string | null | undefined },
  gewuenscht?: string | null,
): string | null {
  const favoritenZuerst = einstellung.startFavoriten ?? true
  const kandidaten: (string | null | undefined)[] = [
    gewuenscht,
    favoritenZuerst ? FAVORITEN_TAB_ID : einstellung.startKategorieId,
    ...(favoritenZuerst ? [] : lage.kategorieIdsMitArtikeln),
    FAVORITEN_TAB_ID,
    ...lage.kategorieIdsMitArtikeln,
    SONSTIGE_TAB_ID,
    ...lage.kategorieIds,
  ]
  return kandidaten.find(t => reiterGueltig(t, lage)) ?? null
}
