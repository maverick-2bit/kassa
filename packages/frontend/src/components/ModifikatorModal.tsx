/**
 * ModifikatorModal — zeigt Modifikator-Gruppen für einen Artikel an.
 *
 * Pflicht-Gruppen müssen ausgewählt werden (mindestens 1 Option).
 * Optional-Gruppen können übersprungen werden.
 * Bei maxAuswahl > 1 können mehrere Optionen ausgewählt werden.
 */

import { useMemo, useState } from 'react'
import type { Artikel, ModifikatorAuswahl, ModifikatorGruppe } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:     boolean
  artikel:  Artikel | null
  gruppen:  ModifikatorGruppe[]
  onOk:     (artikel: Artikel, auswahl: ModifikatorAuswahl[]) => void
  onClose:  () => void
}

export function ModifikatorModal({ open, artikel, gruppen, onOk, onClose }: Props) {
  // auswahl: gruppeId → Set<modifikatorId>
  const [auswahl, setAuswahl] = useState<Map<string, Set<string>>>(new Map())

  const aktiveGruppen = useMemo(
    () => gruppen.filter(g => g.aktiv && g.modifikatoren.some(m => m.aktiv)),
    [gruppen],
  )

  // Zurücksetzen bei Öffnung
  if (!open && auswahl.size > 0) {
    setAuswahl(new Map())
  }

  const toggleOption = (gruppe: ModifikatorGruppe, modId: string) => {
    setAuswahl(prev => {
      const next = new Map(prev)
      const sel  = new Set(next.get(gruppe.id) ?? [])
      const max  = gruppe.maxAuswahl ?? Infinity

      if (sel.has(modId)) {
        sel.delete(modId)
      } else {
        if (max === 1) {
          // Radio-Modus: nur eine Option möglich
          sel.clear()
          sel.add(modId)
        } else if (sel.size < max) {
          sel.add(modId)
        }
        // wenn max bereits erreicht: ignorieren
      }

      next.set(gruppe.id, sel)
      return next
    })
  }

  const isValid = aktiveGruppen
    .filter(g => g.typ === 'pflicht')
    .every(g => (auswahl.get(g.id)?.size ?? 0) > 0)

  const gesamtAufschlag = useMemo(() => {
    let sum = 0
    for (const gruppe of aktiveGruppen) {
      const sel = auswahl.get(gruppe.id) ?? new Set()
      for (const modId of sel) {
        const mod = gruppe.modifikatoren.find(m => m.id === modId)
        if (mod) sum += mod.aufschlagCent
      }
    }
    return sum
  }, [auswahl, aktiveGruppen])

  const handleOk = () => {
    if (!artikel || !isValid) return
    const result: ModifikatorAuswahl[] = []
    for (const gruppe of aktiveGruppen) {
      const sel = auswahl.get(gruppe.id) ?? new Set()
      for (const modId of sel) {
        const mod = gruppe.modifikatoren.find(m => m.id === modId)
        if (mod) {
          result.push({
            modifikatorId:  mod.id,
            gruppeId:       gruppe.id,
            gruppeName:     gruppe.name,
            name:           mod.name,
            aufschlagCent:  mod.aufschlagCent,
          })
        }
      }
    }
    onOk(artikel, result)
    setAuswahl(new Map())
  }

  const basisPreis = artikel?.preisBruttoCent ?? 0
  const gesamtPreis = basisPreis + gesamtAufschlag

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={artikel?.bezeichnung ?? 'Optionen'}
      size="md"
    >
      {aktiveGruppen.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">Keine Optionen verfügbar.</p>
      ) : (
        <div className="space-y-5">
          {aktiveGruppen.map(gruppe => {
            const sel     = auswahl.get(gruppe.id) ?? new Set()
            const max     = gruppe.maxAuswahl ?? Infinity
            const isPflicht = gruppe.typ === 'pflicht'
            const isErfuellt = sel.size > 0

            return (
              <div key={gruppe.id}>
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-gray-800">{gruppe.name}</h3>
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
                    <span className="text-xs text-gray-400">Optional</span>
                  )}
                  {max !== Infinity && max > 1 && (
                    <span className="text-xs text-gray-400">max. {max}</span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {gruppe.modifikatoren.filter(m => m.aktiv).map(mod => {
                    const isGewählt     = sel.has(mod.id)
                    // lagerstandMenge === null → kein Countdown, unbegrenzt
                    // lagerstandMenge === 0   → ausverkauft, nicht wählbar
                    const istAusverkauft = mod.lagerstandMenge === 0
                    const istDeaktiviert = istAusverkauft || (!isGewählt && sel.size >= max)

                    return (
                      <button
                        key={mod.id}
                        type="button"
                        disabled={istDeaktiviert}
                        onClick={() => !istAusverkauft && toggleOption(gruppe, mod.id)}
                        className={`
                          flex flex-col rounded-lg border px-3 py-2.5 text-sm
                          transition text-left
                          ${isGewählt
                            ? 'border-brand-500 bg-brand-50 text-brand-800 font-medium ring-1 ring-brand-400'
                            : istAusverkauft
                            ? 'border-gray-200 bg-gray-50 text-gray-300 cursor-not-allowed'
                            : istDeaktiviert
                            ? 'border-gray-200 bg-gray-50 text-gray-300 cursor-not-allowed'
                            : 'border-gray-200 bg-white hover:border-brand-300 hover:bg-brand-50 text-gray-700'
                          }
                        `}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span>{mod.name}</span>
                          {mod.aufschlagCent !== 0 && (
                            <span className={`ml-2 text-xs font-mono ${
                              mod.aufschlagCent > 0 ? 'text-orange-600' : 'text-green-600'
                            }`}>
                              {mod.aufschlagCent > 0 ? '+' : ''}{formatPreis(mod.aufschlagCent)}
                            </span>
                          )}
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
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Gesamtpreis-Vorschau */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <span className="text-sm text-gray-600">
              {formatPreis(basisPreis)}
              {gesamtAufschlag !== 0 && (
                <span className={`ml-1 text-xs ${gesamtAufschlag > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {gesamtAufschlag > 0 ? '+' : ''}{formatPreis(gesamtAufschlag)}
                </span>
              )}
            </span>
            <span className="text-base font-bold text-gray-900">{formatPreis(gesamtPreis)}</span>
          </div>

          {!isValid && (
            <p className="text-xs text-red-600 -mt-2">
              Bitte alle Pflichtfelder auswählen.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
            <Button onClick={handleOk} disabled={!isValid} className="flex-1">
              Hinzufügen · {formatPreis(gesamtPreis)}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
