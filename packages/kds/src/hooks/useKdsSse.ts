import { useEffect, useRef, useCallback } from 'react'
import type { KdsBon, KdsSseEvent } from '../types'
import { kdsEventSourceUrl } from '../api'

interface UseKdsSseOptions {
  station:  string
  token:    string
  onEvent:  (event: KdsSseEvent) => void
}

/**
 * Hält eine SSE-Verbindung zum KDS-Backend und liefert Ereignisse
 * über den onEvent-Callback. Reconnect automatisch nach 3s.
 */
export function useKdsSse({ station, token, onEvent }: UseKdsSseOptions) {
  const esRef    = useRef<EventSource | null>(null)
  const onEventR = useRef(onEvent)
  onEventR.current = onEvent

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
    }

    const url = kdsEventSourceUrl(station, token)
    const es  = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as KdsSseEvent
        onEventR.current(event)
      } catch {
        // ignore parse errors
      }
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
      // Reconnect nach 3 Sekunden
      setTimeout(connect, 3000)
    }
  }, [station, token])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [connect])
}

export type { KdsBon }
