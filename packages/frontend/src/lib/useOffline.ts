/**
 * React-Hook: useOffline
 *
 * Gibt online-Status, Queue-Größe und Sync-Funktion zurück.
 * Jede Komponente die diesen Hook verwendet, re-rendert automatisch
 * wenn sich der Status ändert.
 */

import { useEffect, useState } from 'react'
import { offlineManager } from './offline'

export interface OfflineState {
  online:      boolean
  queueCount:  number
  triggerSync: () => void
}

export function useOffline(): OfflineState {
  const [online,     setOnline]     = useState(offlineManager.online)
  const [queueCount, setQueueCount] = useState(offlineManager.queueCount)

  useEffect(() => {
    const unsub = offlineManager.subscribe((event) => {
      switch (event.type) {
        case 'STATUS_CHANGE':
          setOnline(event.online)
          break
        case 'QUEUE_COUNT':
          setQueueCount(event.count)
          break
        case 'SYNC_DONE':
          offlineManager.requestQueueCount()
          break
      }
    })

    // Initialer Queue-Stand abrufen
    offlineManager.requestQueueCount()

    return unsub
  }, [])

  return {
    online,
    queueCount,
    triggerSync: () => offlineManager.triggerSync(),
  }
}
