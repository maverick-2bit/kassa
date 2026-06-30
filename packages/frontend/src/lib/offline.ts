/**
 * Offline-Manager — Frontend-Seite des Offline-Systems
 *
 * Verantwortlichkeiten:
 *  - Service Worker registrieren
 *  - Online/Offline-Status beobachten
 *  - Queue-Größe vom SW abfragen
 *  - Manuellen Sync auslösen
 *  - SW-Messages als Callbacks weiterleiten
 */

export type OfflineEvent =
  | { type: 'STATUS_CHANGE';     online: boolean }
  | { type: 'QUEUE_COUNT';       count: number }
  | { type: 'BELEG_QUEUED';      id: number }
  | { type: 'BELEG_SYNCED';      id: number; status: number }
  | { type: 'BELEG_SYNC_FEHLER'; id: number; status: number }
  | { type: 'SYNC_DONE' }

type OfflineListener = (event: OfflineEvent) => void

export class OfflineManager {
  private listeners:   Set<OfflineListener> = new Set()
  private _online:     boolean              = navigator.onLine
  private _queueCount: number               = 0
  private _swReady:    boolean              = false

  get online():     boolean { return this._online }
  get queueCount(): number  { return this._queueCount }
  get swReady():    boolean { return this._swReady }

  /** Einmalig beim App-Start aufrufen. */
  async init(): Promise<void> {
    // Online/Offline-Events
    window.addEventListener('online',  () => this.handleOnline())
    window.addEventListener('offline', () => this.handleOffline())

    // Service Worker registrieren
    if (!('serviceWorker' in navigator)) return

    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      this._swReady = true
      console.info('[Offline] Service Worker registriert:', reg.scope)

      // Background Sync registrieren (wenn verfügbar)
      if ('sync' in reg) {
        window.addEventListener('online', async () => {
          try {
            await (reg as any).sync.register('kassa-beleg-sync')
          } catch { /* ignorieren */ }
        })
      }
    } catch (err) {
      console.warn('[Offline] Service Worker Registrierung fehlgeschlagen:', err)
      return
    }

    // SW-Messages empfangen
    navigator.serviceWorker.addEventListener('message', (event) => {
      this.handleSwMessage(event.data)
    })

    // Initiale Queue-Größe abfragen
    this.requestQueueCount()
  }

  /** Observer registrieren — gibt eine Unsubscribe-Funktion zurück. */
  subscribe(fn: OfflineListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Manuellen Sync auslösen (Fallback für Browser ohne Background Sync API). */
  triggerSync(): void {
    if (!this._swReady || !navigator.serviceWorker.controller) return
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_NOW' })
  }

  /** Aktuelle Queue-Größe vom SW abfragen. */
  requestQueueCount(): void {
    if (!this._swReady || !navigator.serviceWorker.controller) return
    navigator.serviceWorker.controller.postMessage({ type: 'GET_QUEUE_COUNT' })
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private handleOnline(): void {
    this._online = true
    this.emit({ type: 'STATUS_CHANGE', online: true })
    // Sync anstoßen
    this.triggerSync()
  }

  private handleOffline(): void {
    this._online = false
    this.emit({ type: 'STATUS_CHANGE', online: false })
  }

  private handleSwMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const msg = data as Record<string, unknown>

    switch (msg.type) {
      case 'QUEUE_COUNT':
        this._queueCount = msg.count as number
        this.emit({ type: 'QUEUE_COUNT', count: this._queueCount })
        break
      case 'BELEG_QUEUED':
        this._queueCount++
        this.emit({ type: 'BELEG_QUEUED', id: msg.id as number })
        this.emit({ type: 'QUEUE_COUNT',  count: this._queueCount })
        break
      case 'BELEG_SYNCED':
        this._queueCount = Math.max(0, this._queueCount - 1)
        this.emit({ type: 'BELEG_SYNCED', id: msg.id as number, status: msg.status as number })
        this.emit({ type: 'QUEUE_COUNT',  count: this._queueCount })
        break
      case 'BELEG_SYNC_FEHLER':
        this.emit({ type: 'BELEG_SYNC_FEHLER', id: msg.id as number, status: msg.status as number })
        break
      case 'SYNC_DONE':
        this.requestQueueCount()
        this.emit({ type: 'SYNC_DONE' })
        break
    }
  }

  private emit(event: OfflineEvent): void {
    this.listeners.forEach((fn) => {
      try { fn(event) } catch { /* ignorieren */ }
    })
  }
}

/** Singleton — im gesamten Frontend verwenden. */
export const offlineManager = new OfflineManager()
