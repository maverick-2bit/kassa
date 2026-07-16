import { useState, useEffect } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { formatPreis } from '../lib/format'
import { zahlungsAufteilung } from '../lib/warenkorb'

interface BarKarteSplitModalProps {
  open:      boolean
  /** Zu zahlender Betrag in Cent (Bar-Anteil + Karten-Anteil ergeben diese Summe) */
  summeCent: number
  onClose:   () => void
  /** Übergibt den gewählten Split; der Rest nach Bar läuft automatisch auf Karte. */
  onSubmit:  (barCentBeleg: number, karteCentBeleg: number) => void
}

const ZIFFERN = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'] as const

/**
 * Gemischte Zahlung: der Kassier tippt den BAR-Anteil, der Rest läuft automatisch
 * auf Karte (bei aktivem ZVT geht nur der Karten-Anteil ans Terminal). Zahlt der
 * Gast mehr bar als die Summe, wird der Bar-Anteil gedeckelt und das Wechselgeld
 * angezeigt (dann ist der Karten-Anteil 0 = reine Barzahlung).
 */
export function BarKarteSplitModal({ open, summeCent, onClose, onSubmit }: BarKarteSplitModalProps) {
  const [barGegebenCent, setBarGegebenCent] = useState(0)

  useEffect(() => { if (open) setBarGegebenCent(0) }, [open])

  const { barCentBeleg, karteCentBeleg, wechselgeldCent } = zahlungsAufteilung(summeCent, barGegebenCent)
  const kannBuchen = barGegebenCent > 0

  const schnellwerte = [
    { label: 'Hälfte', cent: Math.round(summeCent / 2) },
    { label: '€ 10',   cent: 1000 },
    { label: '€ 20',   cent: 2000 },
    { label: '€ 50',   cent: 5000 },
    { label: '€ 100',  cent: 10000 },
  ]

  const tippe = (taste: string) => {
    setBarGegebenCent((c) => {
      if (taste === '⌫') return Math.floor(c / 10)
      if (taste === '00') return Math.min(c * 100, 99_999_99)
      return Math.min(c * 10 + Number(taste), 99_999_99)
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="Bar + Karte aufteilen" size="sm">
      <div className="space-y-4">
        {/* Split-Übersicht */}
        <div className="rounded-lg border border-line bg-panel-2 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-sm text-ink-muted">
            <span>Zu zahlen</span>
            <span className="font-mono font-medium text-ink">{formatPreis(summeCent)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-muted">Bar</span>
            <span className="font-mono text-xl font-bold text-ink">{formatPreis(barCentBeleg)}</span>
          </div>
          <div className="h-px bg-line" />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Rest auf Karte</span>
            <span className={`font-mono text-2xl font-bold ${karteCentBeleg > 0 ? 'text-blue-600' : 'text-ink-subtle'}`}>
              {formatPreis(karteCentBeleg)}
            </span>
          </div>
          {wechselgeldCent > 0 && (
            <div className="flex items-center justify-between text-sm text-green-700">
              <span className="font-medium">Wechselgeld</span>
              <span className="font-mono font-semibold">{formatPreis(wechselgeldCent)}</span>
            </div>
          )}
        </div>

        {/* Schnellbeträge (Bar-Anteil) */}
        <div className="grid grid-cols-5 gap-2">
          {schnellwerte.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setBarGegebenCent(s.cent)}
              className="rounded-lg border border-line bg-panel px-1 py-2 text-xs font-semibold text-ink hover:bg-panel-2 active:scale-95 transition"
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Ziffernblock (Bar-Anteil) */}
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
          <Button variant="secondary" onClick={() => setBarGegebenCent(0)} className="flex-1">
            Löschen
          </Button>
          <Button onClick={() => onSubmit(barCentBeleg, karteCentBeleg)} disabled={!kannBuchen} className="flex-[2]">
            {karteCentBeleg > 0 ? 'Bar + Karte buchen' : 'Bar buchen'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
