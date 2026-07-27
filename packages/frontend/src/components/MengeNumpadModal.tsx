/**
 * Mengen-Eingabe per Ziffernblock — für Warenkorb (Kasse) und Tisch-Positionen.
 * Touch-first: große Tasten, ⌫, Übernehmen. 0 ist erlaubt, wenn `nullErlaubt`
 * (bedeutet dort „Position entfernen").
 */

import { useEffect, useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

const ZIFFERN = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '', '0', '⌫'] as const

interface Props {
  open:         boolean
  titel:        string
  /** Vorbelegte Menge (wird beim Öffnen angezeigt; erste Zifferneingabe ersetzt sie) */
  startMenge:   number
  nullErlaubt?: boolean
  maxMenge?:    number
  onClose:      () => void
  onSubmit:     (menge: number) => void
}

export function MengeNumpadModal({ open, titel, startMenge, nullErlaubt = false, maxMenge, onClose, onSubmit }: Props) {
  const [wert, setWert]       = useState('')
  const [ersetzt, setErsetzt] = useState(false)

  useEffect(() => {
    if (open) { setWert(String(startMenge)); setErsetzt(false) }
  }, [open, startMenge])

  const menge  = wert === '' ? 0 : parseInt(wert, 10)
  const zuGross = maxMenge !== undefined && menge > maxMenge
  const gueltig = !zuGross && (nullErlaubt ? menge >= 0 : menge >= 1) && wert !== ''

  const tippe = (t: string) => {
    if (t === '⌫') { setWert(v => v.slice(0, -1)); setErsetzt(true); return }
    if (t === '') return
    setWert(v => {
      const basis = ersetzt ? v : ''            // erste Eingabe ersetzt die Vorbelegung
      const neu   = (basis + t).replace(/^0+(?=\d)/, '')
      return neu.slice(0, 3)                     // 999 reicht an jeder Kasse
    })
    setErsetzt(true)
  }

  return (
    <Modal open={open} onClose={onClose} title={titel} size="sm">
      <div className="space-y-4">
        <div className={`rounded-lg border px-4 py-3 text-center text-3xl font-mono font-bold ${
          zuGross ? 'border-red-300 bg-red-50 text-red-700' : 'border-line bg-panel-2 text-ink'
        }`}>
          {wert === '' ? '–' : menge}
        </div>
        {zuGross && <p className="text-xs text-red-600 text-center">Maximal {maxMenge} möglich</p>}
        {nullErlaubt && menge === 0 && wert !== '' && (
          <p className="text-xs text-amber-700 text-center">0 = Position wird entfernt</p>
        )}

        <div className="grid grid-cols-3 gap-2">
          {ZIFFERN.map((z, i) => (
            <button
              key={i}
              type="button"
              onClick={() => tippe(z)}
              disabled={z === ''}
              className={`rounded-lg border border-line-strong py-3 text-lg font-semibold ${
                z === '' ? 'invisible' : 'bg-panel hover:bg-panel-2 active:bg-brand-50'
              }`}
            >
              {z}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={() => onSubmit(menge)} disabled={!gueltig} className="flex-1">
            Übernehmen
          </Button>
        </div>
      </div>
    </Modal>
  )
}
