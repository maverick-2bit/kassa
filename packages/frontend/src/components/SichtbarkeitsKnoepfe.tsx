/**
 * SichtbarkeitsKnoepfe — die zwei Knöpfe „Alle sichtbar" und „Alle ausblenden" einer Kasse.
 *
 * Gemeinsam für die Matrix „Warengruppen-Verteilung" (Spaltenkopf je Kasse) und den Tab „Warengruppen"
 * der POS-Konfiguration: gleiche Beschriftung, gleiche Tooltips, gleiches Verhalten (lib/sichtbarkeit).
 * Beide Knöpfe sind Umschalter (aria-pressed): „Alle sichtbar" ist gedrückt, solange alle Haken gesetzt
 * sind; „Alle ausblenden" ist gedrückt, solange die Auswahl neu begonnen wird (alle Haken leer, noch
 * nichts gespeichert). Ein erneuter Klick auf den gedrückten Knopf schaltet auf den anderen Zustand.
 */

import { SICHTBARKEIT_TEXTE, alleAusblendenTitel, alleSichtbarTitel, type AuswahlArt } from '../lib/sichtbarkeit'

interface Props {
  art:              AuswahlArt
  onAlleSichtbar:   () => void
  onAlleAusblenden: () => void
  disabled?:        boolean
  /** Präfix der Test-IDs: `${testId}-alle-sichtbar` und `${testId}-alle-ausblenden` */
  testId:           string
  /** Name der Kasse für die zugänglichen Namen („Alle sichtbar an Bar") — nötig, wo mehrere Kassen nebeneinander stehen */
  kassenName?:      string | undefined
  /** Klein und untereinander (Spaltenkopf der Matrix) statt nebeneinander */
  kompakt?:         boolean
}

export function SichtbarkeitsKnoepfe({ art, onAlleSichtbar, onAlleAusblenden, disabled = false, testId, kassenName, kompakt = false }: Props) {
  const basis = `rounded-md border font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
    kompakt ? 'px-2 py-0.5 text-[11px] leading-4' : 'px-3 py-1.5 text-sm'
  }`
  const normal = 'border-line text-ink-muted hover:border-brand-400 hover:text-brand-700'

  return (
    <div className={kompakt ? 'mt-1.5 flex flex-col gap-1' : 'flex items-center gap-2'}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={art === 'alle'}
        aria-label={kassenName ? `${SICHTBARKEIT_TEXTE.knopfAlle} an ${kassenName}` : undefined}
        onClick={onAlleSichtbar}
        data-testid={`${testId}-alle-sichtbar`}
        title={alleSichtbarTitel(art)}
        className={`${basis} ${art === 'alle' ? 'border-green-300 bg-green-50 text-green-700' : normal}`}
      >{SICHTBARKEIT_TEXTE.knopfAlle}</button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={art === 'keine'}
        aria-label={kassenName ? `${SICHTBARKEIT_TEXTE.knopfAusblenden} an ${kassenName}` : undefined}
        onClick={onAlleAusblenden}
        data-testid={`${testId}-alle-ausblenden`}
        title={alleAusblendenTitel(art)}
        className={`${basis} ${art === 'keine' ? 'border-amber-300 bg-amber-50 text-amber-800' : normal}`}
      >{SICHTBARKEIT_TEXTE.knopfAusblenden}</button>
    </div>
  )
}
