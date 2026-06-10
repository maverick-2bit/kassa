import { useCallback, useState } from 'react'
import type { BonierbonEvent, KasseEvent, LagerstandWarnungEvent } from '@kassa/shared'
import { STATION_LABELS } from '@kassa/shared'
import { useKasseEvents } from '../lib/sse'

type ToastTyp = 'bonierbon' | 'lagerstand'

interface Toast {
  id:        number
  typ:       ToastTyp
  bonierbon?: BonierbonEvent
  lagerstand?: LagerstandWarnungEvent
  timestamp: Date
}

let nextId = 0

export function KdsToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const handleEvent = useCallback((event: KasseEvent) => {
    if (event.typ !== 'bonierbon' && event.typ !== 'lagerstand_warnung') return
    const id = ++nextId
    const ttl = event.typ === 'lagerstand_warnung' ? 10_000 : 6_000
    setToasts((prev) => [
      ...prev.slice(-4),
      {
        id,
        typ:       event.typ === 'bonierbon' ? 'bonierbon' : 'lagerstand',
        ...(event.typ === 'bonierbon'          ? { bonierbon:  event } : {}),
        ...(event.typ === 'lagerstand_warnung' ? { lagerstand: event } : {}),
        timestamp: new Date(),
      },
    ])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl)
  }, [])

  useKasseEvents(handleEvent)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
      {toasts.map((t) => t.typ === 'bonierbon' && t.bonierbon ? (
        <BonierbonToast
          key={t.id}
          event={t.bonierbon}
          timestamp={t.timestamp}
          onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
        />
      ) : t.typ === 'lagerstand' && t.lagerstand ? (
        <LagerstandToast
          key={t.id}
          event={t.lagerstand}
          onClose={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
        />
      ) : null)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lagerstand-Warnung Toast
// ---------------------------------------------------------------------------

function LagerstandToast({ event, onClose }: { event: LagerstandWarnungEvent; onClose: () => void }) {
  return (
    <div className="w-72 rounded-lg border shadow-lg text-sm animate-slide-in bg-orange-50 border-orange-300">
      <div className="flex items-start justify-between px-3 pt-2.5 pb-2 gap-2">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <svg className="h-4 w-4 text-orange-500 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
          </svg>
          <div className="min-w-0">
            <p className="font-semibold text-orange-900 truncate">
              {event.ausverkauft ? 'Ausverkauft' : 'Lagerstand niedrig'}
            </p>
            <p className="text-xs text-orange-800 mt-0.5 truncate">{event.bezeichnung}</p>
            <p className="text-xs text-orange-600 mt-0.5">
              {event.ausverkauft
                ? 'Kein Bestand mehr vorhanden'
                : `Bestand: ${event.menge} (Min: ${event.mindestbestand})`}
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-orange-400 hover:text-orange-600 shrink-0 leading-none">×</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bonierbon Toast
// ---------------------------------------------------------------------------

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
