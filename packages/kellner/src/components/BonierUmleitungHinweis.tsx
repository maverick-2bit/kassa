/**
 * Bernsteinfarbener Hinweis: Ein Bon wurde ZUGESTELLT — aber nicht am vorgesehenen Bonierdrucker,
 * sondern an dessen Backup-Drucker bzw. dem festen Fallback-Drucker.
 *
 * Gegenstück zur roten „Bon NICHT angekommen"-Meldung für „angekommen, aber woanders": Der Bon liegt
 * am falschen Gerät, und ohne Hinweis holt ihn in der Küche niemand ab. Blockiert nichts (kein Overlay,
 * Bonieren und Kassieren gehen weiter), bleibt aber stehen, bis „Verstanden" gedrückt wird. Bewusst
 * kompakt — er teilt sich die feste Fußleiste mit den Knöpfen und den übrigen Meldungen.
 */

import type { BonierUmleitung } from '@kassa/shared'

export function BonierUmleitungHinweis({ umleitungen, onVerstanden }: {
  umleitungen:  BonierUmleitung[]
  onVerstanden: () => void
}) {
  return (
    <div
      role="status"
      data-testid="bonier-umleitung"
      className="flex items-center gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3"
    >
      <ul className="flex-1 space-y-1 text-xs font-semibold text-amber-900">
        {umleitungen.map((u, i) => (
          <li key={`${u.von}-${u.an}-${i}`}>⚠ {u.hinweis}</li>
        ))}
      </ul>
      <button
        type="button"
        className="shrink-0 rounded-lg border border-amber-500 px-3 py-3 text-sm font-bold text-amber-800 active:bg-amber-100"
        onClick={onVerstanden}
      >
        Verstanden
      </button>
    </div>
  )
}
