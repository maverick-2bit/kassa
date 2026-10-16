/**
 * Optionen-/Varianten-Abfrage im Direktverkauf.
 *
 * An einer Bar-Kasse, an der dieselbe Person verkauft und herrichtet, braucht es die Abfrage „pur oder gespritzt"
 * nicht; die Küche dagegen braucht Optionen/Varianten weiter. Gesteuert wird in drei Ebenen — die genaueste gewinnt:
 *
 *   Artikel  →  Warengruppe  →  Kasse
 *
 * Auf Artikel und Warengruppe heißt NULL „wie die nächste Ebene", true „immer fragen", false „nie fragen". Die Kasse
 * kennt nur ja/nein (Standard ja = bisheriges Verhalten). Betrifft NUR den Direktverkauf (Kasse, Kellner-App im
 * Theken-Modus): Tisch-Bestellungen fragen immer — dort wird für Küche/Schank bestellt.
 */

/** Wert auf Artikel/Warengruppe: null = erben, true = immer fragen, false = nie fragen. */
export type OptionenAbfrageWahl = boolean | null

export interface OptionenAbfrageLage {
  /** Einstellung der Kasse; fehlt sie (Konfiguration noch nicht geladen), wird gefragt — wie bisher. */
  kasse?:       boolean | null | undefined
  /** Wahl der Warengruppe des Artikels (bei Untergruppen: die der Untergruppe, sonst erbt sie von der Obergruppe) */
  warengruppe?: OptionenAbfrageWahl | undefined
  /** Wahl des Artikels */
  artikel?:     OptionenAbfrageWahl | undefined
}

/** Soll beim Hinzufügen des Artikels im Direktverkauf nach Optionen/Varianten gefragt werden? */
export function fragtNachOptionen(lage: OptionenAbfrageLage): boolean {
  if (lage.artikel !== null && lage.artikel !== undefined) return lage.artikel
  if (lage.warengruppe !== null && lage.warengruppe !== undefined) return lage.warengruppe
  return lage.kasse ?? true
}

/**
 * Wahl einer Warengruppe samt Vererbung: eine Untergruppe ohne eigene Wahl übernimmt die der Obergruppe
 * (z. B. „Küche" auf „immer fragen" gilt auch für alle ihre Untergruppen). Zyklen im Altbestand werden abgefangen.
 */
export function warengruppenWahl(
  gruppen: readonly { id: string; parentId: string | null; optionenAbfrage?: OptionenAbfrageWahl | undefined }[],
  kategorieId: string | null | undefined,
): OptionenAbfrageWahl {
  if (!kategorieId) return null
  const nachId = new Map(gruppen.map(g => [g.id, g] as const))
  const besucht = new Set<string>()
  for (let cur = nachId.get(kategorieId); cur && !besucht.has(cur.id); cur = cur.parentId ? nachId.get(cur.parentId) : undefined) {
    besucht.add(cur.id)
    if (cur.optionenAbfrage !== null && cur.optionenAbfrage !== undefined) return cur.optionenAbfrage
  }
  return null
}
