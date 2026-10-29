/**
 * Wischen (Swipe) zwischen den Warengruppen-Reitern — die Rechenregeln, ohne Bildschirm.
 *
 * Wer mit dem Finger nach LINKS wischt, will zum NÄCHSTEN Reiter (wie Seiten umblättern); nach RECHTS zum vorherigen.
 * Ein Tipp, ein langsames Ziehen zum Scrollen oder ein schräger Wisch zählt nicht.
 */

export type SwipeRichtung = 'links' | 'rechts'
export interface SwipePunkt { x: number; y: number }

/** So weit muss der Finger waagrecht wandern (Pixel), damit es ein Wisch ist. */
export const SWIPE_MIN_PX = 60
/** Der waagrechte Weg muss mindestens so viel länger sein als der senkrechte — sonst will jemand scrollen. */
export const SWIPE_WAAGRECHT_FAKTOR = 1.5

export function swipeRichtung(
  start: SwipePunkt,
  ende:  SwipePunkt,
  minPx: number = SWIPE_MIN_PX,
): SwipeRichtung | null {
  const dx = ende.x - start.x
  const dy = ende.y - start.y
  if (Math.abs(dx) < minPx) return null
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_WAAGRECHT_FAKTOR) return null
  return dx < 0 ? 'links' : 'rechts'
}

/**
 * Der Reiter, zu dem ein Wisch führt: links = der nächste, rechts = der vorherige. Am Ende (ersten/letzten Reiter) bleibt
 * es dabei: null — kein Herumspringen. Ist der aktuelle Reiter unbekannt, ist es auch null.
 */
export function nachbarReiter(ids: readonly string[], aktuell: string | null, richtung: SwipeRichtung): string | null {
  if (aktuell === null) return null
  const i = ids.indexOf(aktuell)
  if (i < 0) return null
  return ids[richtung === 'links' ? i + 1 : i - 1] ?? null
}
