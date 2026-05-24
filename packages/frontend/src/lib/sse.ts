import { useEffect, useRef } from 'react'
import type { KasseEvent } from '@kassa/shared'
import { getToken } from './auth'

const SSE_URL = '/sse/events'

export function useKasseEvents(onEvent: (event: KasseEvent) => void): void {
  // Ref damit der Callback immer frisch ist, ohne den Effect neu aufzumachen
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    const token = getToken()
    if (!token) return

    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    const connect = () => {
      if (destroyed) return
      es = new EventSource(`${SSE_URL}?token=${encodeURIComponent(token)}`)

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as KasseEvent
          onEventRef.current(event)
        } catch {
          // ignorieren — ungültiger JSON
        }
      }

      es.onerror = () => {
        es?.close()
        es = null
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 3_000)
        }
      }
    }

    connect()

    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    }
  }, []) // token ändert sich nach Login nicht
}
