/**
 * Bernsteinfarbener Hinweis: Ein Bon wurde ZUGESTELLT — aber nicht am vorgesehenen Bonierdrucker,
 * sondern an dessen Backup-Drucker bzw. dem festen Fallback-Drucker.
 *
 * Das Gegenstück zur roten BonierFehlerLeiste für „angekommen, aber woanders": Der Bon liegt am
 * falschen Gerät, und ohne Hinweis holt ihn in der Küche niemand ab. Blockiert nichts (kein Dialog,
 * keine Sperre — Parken, Kassieren und der nächste Tisch gehen weiter), bleibt aber stehen, bis
 * „Verstanden" gedrückt wird: Auch diese Meldung darf nicht nach 3 Sekunden verschwinden.
 */

import type { BonierUmleitung } from '@kassa/shared'
import { Button } from './ui/Button'

export function BonierUmleitungHinweis({ umleitungen, onVerstanden }: {
  umleitungen:  BonierUmleitung[]
  onVerstanden: () => void
}) {
  return (
    <div
      role="status"
      data-testid="bonier-umleitung"
      className="rounded border-2 border-amber-300 bg-amber-50 p-3 space-y-2"
    >
      <p className="text-xs font-bold text-amber-900">⚠ Bon an anderem Drucker ausgegeben</p>
      <ul className="space-y-1 text-xs text-amber-900">
        {umleitungen.map((u, i) => (
          <li key={`${u.von}-${u.an}-${i}`}>{u.hinweis}</li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button variant="secondary" className="text-xs" onClick={onVerstanden}>
          Verstanden
        </Button>
      </div>
    </div>
  )
}
