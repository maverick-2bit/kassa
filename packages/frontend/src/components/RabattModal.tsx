import { useEffect, useState } from 'react'
import type { RabattInput } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Input } from './ui/Input'

interface RabattModalProps {
  open:       boolean
  summeCent:  number
  onSubmit:   (rabatt: RabattInput) => void
  onClose:    () => void
  /** Überschrift — default "Rabatt hinzufügen" */
  titel?:     string
  /** 'rechnung' = Betrag auf Gesamtsumme | 'artikel' = Betrag auf Einzelpreis */
  modus?:     'rechnung' | 'artikel'
}

export function RabattModal({ open, summeCent, onSubmit, onClose, titel, modus = 'rechnung' }: RabattModalProps) {
  const [typ, setTyp]                   = useState<'prozent' | 'betrag'>('prozent')
  const [prozentInput, setProzentInput] = useState('10')
  const [betragInput, setBetragInput]   = useState('')
  const [bezeichnung, setBezeichnung]   = useState('')
  const [fehler, setFehler]             = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTyp('prozent')
      setProzentInput('10')
      setBetragInput('')
      setBezeichnung('')
      setFehler(null)
    }
  }, [open])

  const rabattCent = typ === 'prozent'
    ? Math.round(summeCent * (parseInt(prozentInput || '0', 10) || 0) / 100)
    : (parseInt(betragInput || '0', 10) || 0)

  const handleSubmit = () => {
    setFehler(null)
    const bez = bezeichnung.trim() || undefined
    if (typ === 'prozent') {
      const p = parseInt(prozentInput || '0', 10) || 0
      if (p < 1 || p > 100) { setFehler('Prozent muss zwischen 1 und 100 liegen'); return }
      onSubmit({ typ: 'prozent', prozent: p, ...(bez && { bezeichnung: bez }) })
    } else {
      const b = parseInt(betragInput || '0', 10) || 0
      if (b <= 0)          { setFehler('Betrag muss größer als 0 sein'); return }
      if (b >= summeCent)  { setFehler('Rabatt kann nicht größer als die Summe sein'); return }
      onSubmit({ typ: 'betrag', betragCent: b, ...(bez && { bezeichnung: bez }) })
    }
  }

  const previewLabel = modus === 'artikel' ? 'Neuer Einzelpreis' : 'Zu zahlen'

  return (
    <Modal open={open} onClose={onClose} title={titel ?? 'Rabatt hinzufügen'}>
      <div className="space-y-4">
        {/* Typ-Toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['prozent', 'betrag'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTyp(t)}
              className={`flex-1 py-2 text-sm font-medium transition ${
                typ === t
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t === 'prozent' ? 'Prozent (%)' : 'Fixer Betrag (€)'}
            </button>
          ))}
        </div>

        {typ === 'prozent' ? (
          <div>
            <span className="text-sm font-medium text-gray-700">Rabatt in Prozent</span>
            <div className="mt-1 flex gap-2 items-center flex-wrap">
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="10"
                value={prozentInput}
                onChange={(e) => setProzentInput(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-20 text-center"
              />
              <div className="flex gap-1">
                {[5, 10, 15, 20].map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProzentInput(String(p))}
                    className={`rounded border px-2 py-1 text-xs font-medium transition ${
                      prozentInput === String(p)
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Betrag in Cent</span>
            <Input
              autoFocus
              inputMode="numeric"
              placeholder="0"
              value={betragInput}
              onChange={(e) => setBetragInput(e.target.value.replace(/[^0-9]/g, ''))}
              className="mt-1 w-32"
            />
          </label>
        )}

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Bezeichnung (optional)</span>
          <Input
            placeholder="z. B. Mitarbeiterrabatt, Hausrunde …"
            value={bezeichnung}
            onChange={(e) => setBezeichnung(e.target.value)}
            className="mt-1"
          />
        </label>

        {rabattCent > 0 && (
          <p className="text-sm text-green-700 bg-green-50 rounded px-3 py-2 border border-green-200">
            Ersparnis: <strong>−{formatPreis(rabattCent)}</strong>
            {' · '}{previewLabel}: <strong>{formatPreis(summeCent - rabattCent)}</strong>
          </p>
        )}

        {fehler && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={handleSubmit} className="flex-1" disabled={rabattCent <= 0}>
            Rabatt anwenden
          </Button>
        </div>
      </div>
    </Modal>
  )
}
