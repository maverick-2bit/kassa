/**
 * StartReiterAuswahl — Zelle „Artikelwahl startet mit" in der Kassen-Tabelle: öffnet die Artikelwahl dieser Kasse
 * (Direktverkauf, Tische, Kellner-App) mit den Favoriten, mit der ersten Warengruppe oder mit einer bestimmten
 * Warengruppe dieser Kasse? Hat die Kasse nur EINE Warengruppe, gibt es nichts zu wählen — sie öffnet sich von
 * selbst (Regel für alle drei Stellen: @kassa/shared, start-reiter).
 */

import { useMemo } from 'react'
import { kategoriePfad, type EinrichtungKasse, type Kategorie } from '@kassa/shared'
import { startReiterAuswahl, startReiterFelder, startReiterWert } from '../../lib/einrichtung'
import type { KassePatch } from './EinrichtungKontext'

export function StartReiterAuswahl({ kasse, name, kategorien, geladen, speichern, className }: {
  kasse:      EinrichtungKasse
  name:       string
  /** Aktive Warengruppen des Mandanten */
  kategorien: readonly Kategorie[]
  geladen:    boolean
  speichern:  (kasseId: string, patch: KassePatch) => Promise<void>
  className:  string
}) {
  const auswahl = useMemo(() => startReiterAuswahl(kategorien, kasse.sichtbareKategorieIds), [kategorien, kasse.sichtbareKategorieIds])
  const wert    = startReiterWert(kasse)

  if (!geladen) return <span className="text-xs text-ink-subtle">…</span>

  if (auswahl.reiter.length === 1) {
    return (
      <p
        data-testid={`start-reiter-einzige-${kasse.kassenId}`}
        title="Hat die Kasse nur eine Warengruppe, öffnet sie sich von selbst — dann gibt es nichts zu wählen."
        className="min-w-[9rem] text-xs text-ink-muted"
      >
        Öffnet <strong className="font-medium text-ink">{auswahl.reiter[0]!.name}</strong> automatisch
        <span className="block text-ink-subtle">(einzige Warengruppe)</span>
      </p>
    )
  }

  // Die gewählte Warengruppe ist an dieser Kasse gerade ausgeblendet (oder gelöscht): sichtbar lassen statt still umstellen
  const versteckt = wert !== 'favoriten' && wert !== 'erste' && !auswahl.gruppen.some(g => g.id === wert)

  return (
    <select
      aria-label={`Artikelwahl startet mit ${name}`}
      title="Mit welchem Reiter die Artikelwahl an dieser Kasse öffnet (Direktverkauf, Tische, Kellner-App)"
      className={className}
      value={wert}
      onChange={e => void speichern(kasse.id, startReiterFelder(e.target.value))}
    >
      <option value="favoriten">⭐ Favoriten</option>
      <option value="erste">Erste Warengruppe</option>
      {auswahl.gruppen.map(g => <option key={g.id} value={g.id}>{g.pfad}</option>)}
      {versteckt && (
        <option value={wert}>{kategoriePfad(kategorien, wert) || 'Unbekannte Warengruppe'} (ausgeblendet)</option>
      )}
    </select>
  )
}
