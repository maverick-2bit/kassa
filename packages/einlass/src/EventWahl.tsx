import { useEffect, useState } from 'react'
import type { EinlassEvent, EinlassIch } from '@kassa/shared'
import { einlassApi } from './lib/api'
import { datumZeit } from './lib/format'

export function EventWahl({ ich, onGewaehlt, onAbmelden }: {
  ich: EinlassIch
  onGewaehlt: (e: EinlassEvent) => void
  onAbmelden: () => void
}) {
  const [events, setEvents] = useState<EinlassEvent[] | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)

  useEffect(() => {
    einlassApi.events().then(setEvents).catch(err => setFehler(err instanceof Error ? err.message : 'Fehler'))
  }, [])

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <header className="mb-5">
        <p className="text-xs uppercase tracking-wide text-leise">{ich.firmenname} · {ich.geraet.name}</p>
        <h1 className="mt-1 text-2xl font-bold">Für welches Event?</h1>
      </header>

      {fehler && <p className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-200">{fehler}</p>}
      {events === null && !fehler && <p className="text-leise">Lädt …</p>}
      {events?.length === 0 && (
        <p className="rounded-2xl border border-rand bg-flaeche p-5 text-sm text-leise">
          Kein Event mit Einlass. Im Backoffice muss das Event auf „Interner Test" oder „Veröffentlicht" stehen.
        </p>
      )}

      <div className="space-y-3">
        {events?.map(e => (
          <button
            key={e.id} type="button" onClick={() => onGewaehlt(e)}
            className="w-full rounded-2xl border border-rand bg-flaeche p-4 text-left active:bg-rand"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{e.titel}</span>
              {e.status === 'test' && <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200">Test</span>}
            </div>
            <p className="text-sm text-leise">{datumZeit(e.beginn)} · {e.ort}</p>
            <p className="mt-1 text-sm"><strong>{e.besucher}</strong> <span className="text-leise">von {e.tickets} eingelassen</span></p>
          </button>
        ))}
      </div>

      <button type="button" onClick={() => { if (window.confirm('Dieses Gerät abmelden? Danach muss es neu eingerichtet werden.')) onAbmelden() }}
        className="mt-8 w-full text-center text-sm text-leise underline">
        Gerät abmelden
      </button>
    </main>
  )
}
