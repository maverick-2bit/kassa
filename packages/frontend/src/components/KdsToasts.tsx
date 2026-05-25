import { useCallback, useState } from 'react'
import type { BonierbonEvent, KasseEvent } from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { useKasseEvents } from '../lib/sse'

interface Toast {
  id:        number
  event:     BonierbonEvent
  timestamp: Date
}

let nextId = 0

export function KdsToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const handleEvent = useCallback((event: KasseEvent) => {
    if (event.typ !== 'bonierbon') return  // Nur Bonierbons als Toast anzeigen
    const id = ++nextId
    setToasts((prev) => [...prev.slice(-4), { id, event, timestamp: new Date() }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 6_000)
  }, [])

  useKasseEvents(handleEvent)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <BonierbonToast
          key={t.id}
          event={t.event}
          timestamp={t.timestamp}
          onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
        />
      ))}
    </div>
  )
}

function BonierbonToast({
  event,
  timestamp,
  onClose,
}: {
  event: BonierbonEvent
  timestamp: Date
  onClose: () => void
}) {
  const alleErfolgreich = event.stationen.every((s) => s.erfolgreich)
  const hatFehler       = event.stationen.some((s) => !s.erfolgreich)

  return (
    <div
      className={`w-72 rounded-lg border shadow-lg text-sm animate-slide-in ${
        hatFehler
          ? 'bg-red-50 border-red-200'
          : 'bg-green-50 border-green-200'
      }`}
    >
      <div className="flex items-start justify-between px-3 pt-2.5 pb-1 gap-2">
        <div className="flex-1 min-w-0">
          <p className={`font-semibold truncate ${hatFehler ? 'text-red-800' : 'text-green-800'}`}>
            {alleErfolgreich ? 'Boniert' : hatFehler && event.stationen.every((s) => !s.erfolgreich) ? 'Bonierung fehlgeschlagen' : 'Bonierung teilweise fehlgeschlagen'}
            {' '}— Tisch {event.tisch}
          </p>
          <p className="text-xs text-gray-500">
            {event.kellner} · {timestamp.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 shrink-0 leading-none"
          aria-label="Schließen"
        >
          ×
        </button>
      </div>
      <ul className="px-3 pb-2.5 space-y-0.5">
        {event.stationen.map((s) => (
          <li key={s.station} className="flex items-center justify-between text-xs">
            <span className={s.erfolgreich ? 'text-green-700' : 'text-red-700'}>
              {s.erfolgreich ? '✓' : '✗'}{' '}
              {STATION_LABELS[s.station as keyof typeof STATION_LABELS] ?? s.station}
            </span>
            {!s.erfolgreich && s.fehler && (
              <span className="text-red-500 truncate ml-2 max-w-[10rem]">{s.fehler}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
