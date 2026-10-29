/**
 * useSwipe — Wisch-Gesten (links/rechts) auf einem Bereich erkennen (wie in der Kassa-App).
 *
 * Liefert Touch-Handler zum Anhängen an ein Element. Die Regeln (wie weit, wie waagrecht) stehen in @kassa/shared
 * (swipeRichtung). Ein Tipp auf eine Kachel bleibt ein Tipp: erst ein deutlicher waagrechter Wisch löst aus.
 * Nicht ausgelöst wird bei mehr als einem Finger, in Eingabefeldern, in Bereichen mit `data-swipe-aus` und bei
 * langsamem Ziehen (über 1 Sekunde).
 */

import { useRef, type TouchEvent } from 'react'
import { swipeRichtung, type SwipePunkt, type SwipeRichtung } from '@kassa/shared'

const MAX_DAUER_MS = 1000

export function useSwipe(onSwipe: (richtung: SwipeRichtung) => void) {
  const start = useRef<(SwipePunkt & { zeit: number }) | null>(null)

  return {
    onTouchStart: (e: TouchEvent) => {
      const ziel = e.target as Element | null
      const gesperrt = e.touches.length !== 1 || ziel?.closest('input, textarea, select, [data-swipe-aus]')
      const t = e.touches[0]
      start.current = !gesperrt && t ? { x: t.clientX, y: t.clientY, zeit: Date.now() } : null
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current
      start.current = null
      const t = e.changedTouches[0]
      if (!s || !t || Date.now() - s.zeit > MAX_DAUER_MS) return
      const richtung = swipeRichtung(s, { x: t.clientX, y: t.clientY })
      if (richtung) onSwipe(richtung)
    },
    onTouchCancel: () => { start.current = null },
  }
}
