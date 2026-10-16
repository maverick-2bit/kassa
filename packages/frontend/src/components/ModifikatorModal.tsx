/**
 * ModifikatorModal — zeigt Modifikator-Gruppen für einen Artikel an.
 *
 * Pflicht-Gruppen müssen ausgewählt werden (mindestens 1 Option).
 * Optional-Gruppen können übersprungen werden.
 * Jede Option lässt sich mehrfach antippen (Anzahl); bei einer Obergrenze (maxAuswahl) gilt sie für die Summe der
 * Anzahlen der Gruppe, bei maxAuswahl 1 wählt ein Tipp die Option wie bei Radio-Knöpfen.
 *
 * Ist an einer Gruppe „Jede Auswahl = eigener Artikel" gesetzt (z. B. Spritzer süß/Sommer/weiß), wird aus jeder gewählten
 * Option — samt Anzahl — eine eigene Position (@kassa/shared baueAuswahlPositionen); sonst bleibt es eine Position.
 */

import { useMemo, useState } from 'react'
import {
  auswahlGueltig, baueAuswahlPositionen, gruppenSumme,
  type Artikel, type AuswahlPosition, type ModifikatorGruppe,
} from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:     boolean
  artikel:  Artikel | null
  gruppen:  ModifikatorGruppe[]
  /** Eine Position je Auswahl-Aufteilung (meist genau eine) */
  onOk:     (artikel: Artikel, positionen: AuswahlPosition[]) => void
  onClose:  () => void
}

/** gruppeId → (optionId → Anzahl) */
type Mengen = Map<string, Map<string, number>>

export function ModifikatorModal({ open, artikel, gruppen, onOk, onClose }: Props) {
  const [mengen, setMengen] = useState<Mengen>(new Map())

  const aktiveGruppen = useMemo(
    () => gruppen.filter(g => g.aktiv && g.modifikatoren.some(m => m.aktiv))
      // Nur aktive Optionen in die Auswahl — eine deaktivierte soll auch nicht über alte Mengen hineinrutschen
      .map(g => ({ ...g, modifikatoren: g.modifikatoren.filter(m => m.aktiv) })),
    [gruppen],
  )

  // Zurücksetzen bei Öffnung
  if (!open && mengen.size > 0) {
    setMengen(new Map())
  }

  const anzahlVon = (gruppeId: string, modId: string) => mengen.get(gruppeId)?.get(modId) ?? 0

  /** Eine Option um `delta` ändern (+1 = antippen, −1 = zurücknehmen); Radio bei maxAuswahl 1, sonst Obergrenze auf die Summe. */
  const aendere = (gruppe: ModifikatorGruppe, modId: string, delta: 1 | -1) => {
    setMengen(prev => {
      const next    = new Map(prev)
      const gruppeM = new Map(next.get(gruppe.id) ?? [])
      const aktuell = gruppeM.get(modId) ?? 0
      const max     = gruppe.maxAuswahl ?? Infinity

      if (delta === 1) {
        if (max === 1) {
          // Radio-Modus: nur eine Option, einmal
          gruppeM.clear()
          gruppeM.set(modId, 1)
        } else {
          if (gruppenSumme(prev, gruppe.id) >= max) return prev
          gruppeM.set(modId, aktuell + 1)
        }
      } else {
        if (aktuell <= 1) gruppeM.delete(modId)
        else gruppeM.set(modId, aktuell - 1)
      }
      next.set(gruppe.id, gruppeM)
      return next
    })
  }

  /** Bei maxAuswahl 1 nimmt ein zweiter Tipp die Option wieder zurück (wie bisher). */
  const tippe = (gruppe: ModifikatorGruppe, modId: string) =>
    (gruppe.maxAuswahl === 1 && anzahlVon(gruppe.id, modId) > 0) ? aendere(gruppe, modId, -1) : aendere(gruppe, modId, 1)

  const isValid = auswahlGueltig(aktiveGruppen, mengen)
  const positionen = useMemo(() => baueAuswahlPositionen(aktiveGruppen, mengen), [aktiveGruppen, mengen])

  const basisPreis = artikel?.preisBruttoCent ?? 0
  // Summe über ALLE Positionen (bei aufgeteilter Auswahl: jede Position mal ihre Anzahl)
  const gesamtPreis = positionen.reduce(
    (s, p) => s + (basisPreis + p.modifikatoren.reduce((a, m) => a + m.aufschlagCent * (m.menge ?? 1), 0)) * p.menge, 0)
  const anzahlArtikel = positionen.reduce((s, p) => s + p.menge, 0)
  const gesamtAufschlag = gesamtPreis - basisPreis * anzahlArtikel

  const handleOk = () => {
    if (!artikel || !isValid) return
    onOk(artikel, positionen)
    setMengen(new Map())
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={artikel?.bezeichnung ?? 'Optionen'}
      size="md"
    >
      {aktiveGruppen.length === 0 ? (
        <p className="text-sm text-ink-muted py-4 text-center">Keine Optionen verfügbar.</p>
      ) : (
        <div className="space-y-5">
          {aktiveGruppen.map(gruppe => {
            const summe     = gruppenSumme(mengen, gruppe.id)
            const max       = gruppe.maxAuswahl ?? Infinity
            const isPflicht = gruppe.typ === 'pflicht'
            const isErfuellt = summe > 0

            return (
              <div key={gruppe.id}>
                <div className="flex flex-wrap items-baseline gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-ink">{gruppe.name}</h3>
                  {isPflicht && (
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                      isErfuellt
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-600'
                    }`}>
                      Pflicht
                    </span>
                  )}
                  {!isPflicht && (
                    <span className="text-xs text-ink-subtle">Optional</span>
                  )}
                  {max !== Infinity && max > 1 && (
                    <span className="text-xs text-ink-subtle">max. {max}</span>
                  )}
                  {gruppe.jeAuswahlArtikel && (
                    <span className="text-xs text-ink-subtle" data-testid="je-auswahl-hinweis">
                      · jede Auswahl wird ein eigener Artikel (mehrfach antippen = mehrfach)
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {gruppe.modifikatoren.map(mod => {
                    const n              = anzahlVon(gruppe.id, mod.id)
                    const isGewählt      = n > 0
                    // lagerstandMenge === null → kein Countdown, unbegrenzt
                    // lagerstandMenge === 0   → ausverkauft, nicht wählbar
                    const istAusverkauft = mod.lagerstandMenge === 0
                    // Lagerstand begrenzt die Anzahl dieser Option
                    const lagerErreicht  = mod.lagerstandMenge !== null && n >= mod.lagerstandMenge
                    const maxErreicht    = max !== Infinity && max > 1 && summe >= max
                    const istDeaktiviert = istAusverkauft || (!isGewählt && maxErreicht)
                    const kannMehr       = !istAusverkauft && !lagerErreicht && !maxErreicht && max !== 1

                    return (
                      <div
                        key={mod.id}
                        className={`
                          flex flex-col rounded-lg border text-sm transition
                          ${isGewählt
                            ? 'border-brand-500 bg-brand-50 text-brand-800 font-medium ring-1 ring-brand-400'
                            : istDeaktiviert
                            ? 'border-line bg-panel-2 text-ink-subtle'
                            : 'border-line bg-panel hover:border-brand-300 hover:bg-brand-50 text-ink'
                          }
                        `}
                      >
                        <button
                          type="button"
                          data-testid={`option-${mod.id}`}
                          disabled={istDeaktiviert || (isGewählt && max !== 1 && !kannMehr)}
                          onClick={() => !istAusverkauft && (lagerErreicht && max !== 1 ? undefined : tippe(gruppe, mod.id))}
                          className="flex flex-col px-3 py-2.5 text-left disabled:cursor-not-allowed"
                        >
                          <div className="flex items-center justify-between w-full">
                            <span>{mod.name}</span>
                            <span className="flex items-center gap-1.5">
                              {mod.aufschlagCent !== 0 && (
                                <span className={`text-xs font-mono ${
                                  mod.aufschlagCent > 0 ? 'text-orange-600' : 'text-green-600'
                                }`}>
                                  {mod.aufschlagCent > 0 ? '+' : ''}{formatPreis(mod.aufschlagCent)}
                                </span>
                              )}
                              {n > 1 && (
                                <span data-testid={`anzahl-${mod.id}`} className="rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">×{n}</span>
                              )}
                            </span>
                          </div>
                          {/* Lagerstand-Badge pro Variante */}
                          {istAusverkauft && (
                            <span className="mt-1 text-[10px] text-red-400 font-medium">Ausverkauft</span>
                          )}
                          {!istAusverkauft && mod.lagerstandMenge !== null && mod.lagerstandMenge > 0 && (
                            <span className="mt-1 text-[10px] text-amber-600">
                              noch {mod.lagerstandMenge} verfügbar
                            </span>
                          )}
                        </button>
                        {isGewählt && max !== 1 && (
                          <div className="flex items-center justify-between border-t border-brand-200 px-2 py-1">
                            <button
                              type="button"
                              aria-label={`${mod.name} weniger`}
                              data-testid={`weniger-${mod.id}`}
                              onClick={() => aendere(gruppe, mod.id, -1)}
                              className="h-6 w-6 rounded border border-brand-300 bg-panel text-brand-700 hover:bg-brand-100"
                            >−</button>
                            <span className="text-xs text-brand-700">{n}×</span>
                            <button
                              type="button"
                              aria-label={`${mod.name} mehr`}
                              data-testid={`mehr-${mod.id}`}
                              disabled={!kannMehr}
                              onClick={() => aendere(gruppe, mod.id, 1)}
                              className="h-6 w-6 rounded border border-brand-300 bg-panel text-brand-700 hover:bg-brand-100 disabled:opacity-40"
                            >+</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Gesamtpreis-Vorschau */}
          <div className="flex items-center justify-between pt-2 border-t border-line">
            <span className="text-sm text-ink-muted">
              {anzahlArtikel > 1 ? `${anzahlArtikel} × ` : ''}{formatPreis(basisPreis)}
              {gesamtAufschlag !== 0 && (
                <span className={`ml-1 text-xs ${gesamtAufschlag > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {gesamtAufschlag > 0 ? '+' : ''}{formatPreis(gesamtAufschlag)}
                </span>
              )}
            </span>
            <span className="text-base font-bold text-ink">{formatPreis(gesamtPreis)}</span>
          </div>

          {!isValid && (
            <p className="text-xs text-red-600 -mt-2">
              Bitte alle Pflichtfelder auswählen.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
            <Button onClick={handleOk} disabled={!isValid} className="flex-1">
              {anzahlArtikel > 1 ? `${anzahlArtikel} hinzufügen` : 'Hinzufügen'} · {formatPreis(gesamtPreis)}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
