/**
 * BonierdruckerPage — dünner Wrapper um die BonierdruckerBibliothek.
 * Die eigentliche Verwaltung + Kassen-Zuordnung lebt zentral unter
 * Einstellungen → Hardware; diese Route bleibt für Lesezeichen erhalten.
 */

import { BonierdruckerBibliothek } from '../components/BonierdruckerBibliothek'

export function BonierdruckerPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Bonierdrucker</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Zentral konfigurierte ESC/POS-Drucker für Bonierzettel. Zuordnung zu den Kassen unter
          Einstellungen → Hardware.
        </p>
      </div>
      <BonierdruckerBibliothek />
    </div>
  )
}
