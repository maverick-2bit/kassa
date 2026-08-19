/**
 * PIN-Abfrage für Freigaben (Storno/Rabatt über der Schwelle).
 *
 * Erscheint, wenn das Backend mit code 'freigabe_erforderlich' abgelehnt hat —
 * die Prüfung selbst passiert IMMER serverseitig, dieses Modal sammelt nur den
 * PIN eines Berechtigten ein und lässt den Aufrufer erneut senden.
 */

import { useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface FreigabePinModalProps {
  open:      boolean
  /** Meldung des Backends — nennt die Schwelle („Rabatt ab 20 % Nachlass …") */
  meldung:   string
  laedt?:    boolean
  onBestaetigen: (pin: string) => void
  onAbbrechen:   () => void
}

export function FreigabePinModal({ open, meldung, laedt, onBestaetigen, onAbbrechen }: FreigabePinModalProps) {
  const [pin, setPin] = useState('')

  const bestaetigen = () => {
    if (pin.length >= 4) { onBestaetigen(pin); setPin('') }
  }

  return (
    <Modal open={open} onClose={() => { setPin(''); onAbbrechen() }} title="Freigabe erforderlich">
      <div className="space-y-4">
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {meldung}
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1">PIN eines Berechtigten</label>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') bestaetigen() }}
            maxLength={12}
            placeholder="••••"
            className="w-full rounded-md border border-line-strong px-3 py-2 text-lg tracking-widest text-center
                       focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
          <p className="mt-1 text-xs text-ink-subtle">
            Der eigene Kellner-PIN genügt nicht — es braucht das Recht „Storno freigeben".
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <Button variant="secondary" onClick={() => { setPin(''); onAbbrechen() }}>Abbrechen</Button>
          <Button onClick={bestaetigen} disabled={pin.length < 4} loading={laedt ?? false}>
            Freigeben
          </Button>
        </div>
      </div>
    </Modal>
  )
}
