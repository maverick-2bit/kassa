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

import type { Artikel, Kategorie } from '@kassa/shared'

export const FAVORITEN_TAB_ID = '__favoriten__'
export const SONSTIGE_TAB_ID  = '__sonstige__'

/** Aktive Warengruppen in Kassen-Reihenfolge, gefiltert nach der Kassen-Sichtbarkeit (leer = alle). */
export function sichtbareWarengruppen(
  kategorien: readonly Kategorie[],
  sichtbareKategorieIds: readonly string[] | undefined,
): Kategorie[] {
  const sorted = kategorien
    .filter(k => k.aktiv)
    .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
  return sichtbareKategorieIds && sichtbareKategorieIds.length > 0
    ? sorted.filter(k => sichtbareKategorieIds.includes(k.id))
    : sorted
}

/**
 * Artikel, die an dieser Kasse überhaupt vorkommen dürfen: mit Sichtbarkeits-
 * Liste nur deren Warengruppen, sonst alle (auch ohne Warengruppe).
 */
export function artikelDerKasse(
  artikel: readonly Artikel[],
  sichtbareKategorieIds: readonly string[] | undefined,
): Artikel[] {
  if (!sichtbareKategorieIds || sichtbareKategorieIds.length === 0) return [...artikel]
  return artikel.filter(a => a.kategorieId !== null && sichtbareKategorieIds.includes(a.kategorieId))
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
