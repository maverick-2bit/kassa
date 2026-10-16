/**
 * start-reiter.ts — welcher Reiter der Artikelwahl beim Öffnen aktiv ist (Kasse, Tisch, Kellner-App).
 *
 * EINE Definition für alle Verbraucher (Kasse, Tisch, Kellner-App), damit sie nie auseinanderlaufen.
 *
 * Je Kasse einstellbar (Einstellungen → Kassen & Drucker, auch in der POS-Konfiguration): Favoriten (Standard),
 * eine bestimmte Warengruppe oder „erste Warengruppe". Dazu gilt immer: Hat die Kasse genau EINE Warengruppe mit
 * Artikeln, öffnet sich diese von selbst — Favoriten und „erste Warengruppe" ändern daran nichts. Nur ein
 * ausdrücklicher Wunsch (z. B. ?tab=favoriten über die Startseite „Favoriten") geht vor. Passt keine Einstellung
 * (keine Favoriten, Warengruppe ausgeblendet), greift der nächste sinnvolle Reiter.
 */

export const FAVORITEN_TAB_ID = '__favoriten__'
export const SONSTIGE_TAB_ID  = '__sonstige__'

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

/** Die einzige Warengruppe der Kasse, wenn es genau eine gibt UND sie Artikel hat — sonst null. */
export function einzigeWarengruppe(lage: ReiterLage): string | null {
  const [nur, ...weitere] = lage.kategorieIds
  return nur !== undefined && weitere.length === 0 && lage.kategorieIdsMitArtikeln.includes(nur) ? nur : null
}

export interface StartEinstellung {
  /** true (Standard): Favoriten zuerst */
  startFavoriten?:   boolean | undefined
  /** Gewünschte Warengruppe; null = „erste Warengruppe" (mit Artikeln). Nur wirksam, wenn startFavoriten false ist. */
  startKategorieId?: string | null | undefined
}

/**
 * Start-Reiter: ausdrücklicher Wunsch (z. B. ?tab=favoriten) → die einzige Warengruppe → Einstellung der Kasse →
 * Ersatz. „Erste Warengruppe" (startKategorieId null) meint die erste Warengruppe mit Artikeln, Favoriten kommen
 * dann erst danach.
 */
export function startReiter(
  lage: ReiterLage,
  einstellung: StartEinstellung,
  gewuenscht?: string | null,
): string | null {
  const favoritenZuerst = einstellung.startFavoriten ?? true
  const kandidaten: (string | null | undefined)[] = [
    gewuenscht,
    einzigeWarengruppe(lage),
    favoritenZuerst ? FAVORITEN_TAB_ID : einstellung.startKategorieId,
    ...(favoritenZuerst ? [] : lage.kategorieIdsMitArtikeln),
    FAVORITEN_TAB_ID,
    ...lage.kategorieIdsMitArtikeln,
    SONSTIGE_TAB_ID,
    ...lage.kategorieIds,
  ]
  return kandidaten.find(t => reiterGueltig(t, lage)) ?? null
}
