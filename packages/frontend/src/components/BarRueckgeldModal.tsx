import { useState, useEffect } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { formatPreis } from '../lib/format'

interface BarRueckgeldModalProps {
  open:       boolean
  /** Zu zahlender Betrag in Cent */
  summeCent:  number
  onClose:    () => void
  /** Bestätigt die Barzahlung (der Beleg trägt den Verkaufsbetrag; das Retourgeld ist reine Anzeige) */
  onBuchen:   () => void
}

const ZIFFERN = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'] as const

/**
 * Optionaler Bar-Zahlungs-Dialog mit Ziffernblock: der Kassier tippt den
 * gegebenen Bargeldbetrag, das System zeigt das Retourgeld. Gebucht wird immer
 * der exakte Rechnungsbetrag (das Retourgeld ist nur eine Rechenhilfe).
 */
export function BarRueckgeldModal({ open, summeCent, onClose, onBuchen }: BarRueckgeldModalProps) {
  const [gegebenCent, setGegebenCent] = useState(0)

  // Beim Öffnen zurücksetzen
  useEffect(() => { if (open) setGegebenCent(0) }, [open])

  const gedeckt      = gegebenCent >= summeCent
  const retourgeld   = gegebenCent - summeCent
  const schnellwerte = [
    { label: 'Passend', cent: summeCent },
    { label: '€ 10',    cent: 1000 },
    { label: '€ 20',    cent: 2000 },
    { label: '€ 50',    cent: 5000 },
    { label: '€ 100',   cent: 10000 },
  ]

  const tippe = (taste: string) => {
    setGegebenCent((c) => {
      if (taste === '⌫') return Math.floor(c / 10)
      if (taste === '00') return Math.min(c * 100, 99_999_99)
      return Math.min(c * 10 + Number(taste), 99_999_99)
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="Bar — Betrag geben" size="sm">
      <div className="space-y-4">
        {/* Betragsübersicht */}
        <div className="rounded-lg border border-line bg-panel-2 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-sm text-ink-muted">
            <span>Rechnungsbetrag</span>
            <span className="font-mono font-medium text-ink">{formatPreis(summeCent)}</span>
          </div>
          <div className="flex items-center justify-between text-sm text-ink-muted">
            <span>Gegeben</span>
            <span className="font-mono text-xl font-bold text-ink">{formatPreis(gegebenCent)}</span>
          </div>
          <div className="h-px bg-line" />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Retourgeld</span>
            <span className={`font-mono text-2xl font-bold ${gedeckt ? 'text-green-600' : 'text-ink-subtle'}`}>
              {gedeckt ? formatPreis(retourgeld) : '—'}
            </span>
          </div>
        </div>

        {/* Schnellgeld */}
        <div className="grid grid-cols-5 gap-2">
          {schnellwerte.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setGegebenCent(s.cent)}
              className="rounded-lg border border-line bg-panel px-1 py-2 text-xs font-semibold text-ink hover:bg-panel-2 active:scale-95 transition"
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Ziffernblock */}
        <div className="grid grid-cols-3 gap-2">
          {ZIFFERN.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => tippe(z)}
              className="rounded-lg border border-line bg-panel-2 py-3.5 text-xl font-semibold text-ink hover:bg-panel active:scale-95 transition"
            >
              {z}
            </button>
          ))}
        </div>

        {/* Aktionen */}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={() => setGegebenCent(0)} className="flex-1">
            Löschen
          </Button>
          <Button onClick={onBuchen} disabled={!gedeckt} className="flex-[2]">
            Buchen (Bar)
          </Button>
        </div>
      </div>
    </Modal>
  )
}
