/**
 * SerialAuswahlModal — für jede serialisierte Position genau `menge` Seriennummern
 * aus dem freien Pool des Artikels wählen. Wird beim Lieferschein-Erstellen und
 * beim Kassieren (Rechnung/Bon) verwendet.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { seriennummerApi } from '../lib/api'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

export interface SerialPos {
  positionIndex: number
  bezeichnung:   string
  menge:         number
  artikelId:     string
}

export function SerialAuswahlModal({
  positionen,
  open,
  loading,
  onConfirm,
  onClose,
  title = 'Seriennummern wählen',
  confirmLabel = 'Übernehmen',
}: {
  positionen:    SerialPos[]
  open:          boolean
  loading:       boolean
  onConfirm:     (zuweisungen: { positionIndex: number; seriennummern: string[] }[]) => void
  onClose:       () => void
  title?:        string
  confirmLabel?: string
}) {
  const [auswahl, setAuswahl] = useState<Record<number, string[]>>({})

  const setPos = (idx: number, serials: string[]) => setAuswahl(prev => ({ ...prev, [idx]: serials }))

  const alleVollstaendig = positionen.every(p => (auswahl[p.positionIndex]?.length ?? 0) === Math.round(p.menge))

  const handleConfirm = () => {
    onConfirm(positionen.map(p => ({ positionIndex: p.positionIndex, seriennummern: auswahl[p.positionIndex] ?? [] })))
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-4">
        {positionen.map(p => (
          <PositionPicker
            key={p.positionIndex}
            pos={p}
            gewaehlt={auswahl[p.positionIndex] ?? []}
            onChange={(serials) => setPos(p.positionIndex, serials)}
          />
        ))}
        <div className="flex gap-2 justify-end pt-1 border-t border-line">
          <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
          <Button onClick={handleConfirm} disabled={!alleVollstaendig} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function PositionPicker({
  pos,
  gewaehlt,
  onChange,
}: {
  pos:      SerialPos
  gewaehlt: string[]
  onChange: (serials: string[]) => void
}) {
  const soll = Math.round(pos.menge)
  const query = useQuery({
    queryKey: ['seriennummern', pos.artikelId, 'verfuegbar'],
    queryFn:  () => seriennummerApi.list({ artikelId: pos.artikelId, status: 'verfuegbar' }),
  })
  const frei = query.data ?? []

  const toggle = (sn: string) => {
    if (gewaehlt.includes(sn)) { onChange(gewaehlt.filter(x => x !== sn)); return }
    if (gewaehlt.length >= soll) return  // nicht mehr als die Menge wählen
    onChange([...gewaehlt, sn])
  }

  const ok = gewaehlt.length === soll

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold text-ink">{pos.bezeichnung}</p>
        <span className={`text-xs font-medium ${ok ? 'text-green-700' : 'text-ink-muted'}`}>
          {gewaehlt.length} / {soll} gewählt
        </span>
      </div>
      {frei.length === 0 ? (
        <p className="text-xs text-red-600">Keine freien Seriennummern im Pool — bitte zuerst im Wareneingang erfassen.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
          {frei.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.seriennummer)}
              className={`px-2.5 py-1 rounded-md border text-xs font-mono transition ${
                gewaehlt.includes(s.seriennummer)
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'border-line-strong text-ink hover:border-brand-400'
              }`}
            >
              {s.seriennummer}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
