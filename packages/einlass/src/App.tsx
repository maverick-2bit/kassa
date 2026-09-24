import { useCallback, useEffect, useState } from 'react'
import type { EinlassEvent, EinlassIch } from '@kassa/shared'
import {
  KeineVerbindung,
  NichtAngemeldet,
  abmelden,
  einlassApi,
  leseEvent,
  leseEventId,
  leseIch,
  leseToken,
  merkeEvent,
  merkeEventId,
  merkeIch,
  merkeToken,
} from './lib/api'
import { Einrichtung } from './Einrichtung'
import { EventWahl } from './EventWahl'
import { Scanner } from './Scanner'

type Phase =
  | { art: 'laedt' }
  | { art: 'einrichtung'; hinweis?: string }
  | { art: 'eventwahl'; ich: EinlassIch }
  | { art: 'scanner'; ich: EinlassIch; event: EinlassEvent }

export function App() {
  const [phase, setPhase] = useState<Phase>({ art: 'laedt' })

  const starten = useCallback(async () => {
    // Einrichtungs-Link: ?token=… übernehmen und sofort aus der Adresszeile
    // entfernen (sonst landet er in Lesezeichen und Screenshots)
    const url = new URL(window.location.href)
    const ausLink = url.searchParams.get('token')
    if (ausLink) {
      merkeToken(ausLink)
      url.searchParams.delete('token')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
    if (!leseToken()) { setPhase({ art: 'einrichtung' }); return }

    try {
      const ich = await einlassApi.ich()
      merkeIch(ich)
      const gemerkt = leseEventId()
      if (gemerkt) {
        const event = (await einlassApi.events()).find(e => e.id === gemerkt)
        if (event) { merkeEvent(event); setPhase({ art: 'scanner', ich, event }); return }
        merkeEventId(null)
        merkeEvent(null)
      }
      setPhase({ art: 'eventwahl', ich })
    } catch (err) {
      if (err instanceof NichtAngemeldet) { setPhase({ art: 'einrichtung', hinweis: err.message }); return }
      if (err instanceof KeineVerbindung) {
        // Ohne Netz geöffnet (Akku leer, neu gestartet …): mit dem gemerkten Gerät
        // und Event weiter — die Offline-Liste liegt auf dem Gerät.
        const ich = leseIch()
        const event = leseEvent()
        if (ich && event && leseEventId() === event.id) { setPhase({ art: 'scanner', ich, event }); return }
        setPhase({ art: 'einrichtung', hinweis: 'Keine Verbindung — für den ersten Start braucht das Gerät Netz.' })
        return
      }
      setPhase({ art: 'einrichtung', hinweis: err instanceof Error ? err.message : 'Verbindung fehlgeschlagen' })
    }
  }, [])

  useEffect(() => { void starten() }, [starten])

  switch (phase.art) {
    case 'laedt':
      return <p className="p-8 text-center text-leise">Einlass wird gestartet …</p>
    case 'einrichtung':
      return <Einrichtung hinweis={phase.hinweis} onFertig={() => { setPhase({ art: 'laedt' }); void starten() }} />
    case 'eventwahl':
      return (
        <EventWahl
          ich={phase.ich}
          onGewaehlt={(event) => { merkeEventId(event.id); merkeEvent(event); setPhase({ art: 'scanner', ich: phase.ich, event }) }}
          onAbmelden={() => { abmelden(); setPhase({ art: 'einrichtung' }) }}
        />
      )
    case 'scanner':
      return (
        <Scanner
          ich={phase.ich}
          event={phase.event}
          onEventWechseln={() => { merkeEventId(null); merkeEvent(null); setPhase({ art: 'eventwahl', ich: phase.ich }) }}
          onAbgemeldet={(hinweis) => setPhase({ art: 'einrichtung', hinweis })}
        />
      )
  }
}
