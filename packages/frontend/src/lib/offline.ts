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

import { getToken } from './auth'

/** Ein Verkauf in der Offline-Warteschlange, wie ihn der Service Worker zur Anzeige meldet */
export interface WarteschlangenEintrag {
  id:        number
  createdAt: number
  summeCent: number | null
  /** Gesetzt, wenn das Backend den Verkauf fachlich abgelehnt hat — wird nicht automatisch wiederholt */
  fehler:    { status: number; meldung: string; am: number } | null
  /** Altbestand einer älteren Version (z. B. Storno) ohne Inhalt: kann nur noch verworfen werden */
  nurVerwerfen?: boolean
}

export type OfflineEvent =
  | { type: 'STATUS_CHANGE';     online: boolean }
  | { type: 'QUEUE_COUNT';       count: number }
  | { type: 'QUEUE_LISTE';       eintraege: WarteschlangenEintrag[] }
  | { type: 'BELEG_QUEUED';      id: number }
  | { type: 'BELEG_SYNCED';      id: number; status: number }
  | { type: 'BELEG_SYNC_FEHLER'; id: number; status: number; meldung?: string }
  | { type: 'SYNC_ANMELDUNG_NOETIG' }
  | { type: 'SYNC_DONE' }

type OfflineListener = (event: OfflineEvent) => void

export class OfflineManager {
  private listeners:   Set<OfflineListener> = new Set()
  private _online:     boolean              = navigator.onLine
  private _queueCount: number               = 0
  private _swReady:    boolean              = false

  /** Quelle des Login-Tokens fürs Nachsenden (Tests ersetzen sie) — der SW speichert keinen Token */
  constructor(private readonly tokenQuelle: () => string | null = getToken) {}

  get online():     boolean { return this._online }
  get queueCount(): number  { return this._queueCount }
  get swReady():    boolean { return this._swReady }

  /** Einmalig beim App-Start aufrufen. */
  async init(): Promise<void> {
    // Online/Offline-Events
    window.addEventListener('online',  () => this.handleOnline())
    window.addEventListener('offline', () => this.handleOffline())

    // Service Worker registrieren — NUR im Produktions-Build. Im Dev stören
    // cache-first-SWs nur (Stale-Code-Falle); dort werden Alt-Registrierungen
    // aktiv entfernt. Die versionierte URL (?v=) sorgt dafür, dass der Browser
    // bei jedem Release einen neuen SW installiert (frische, versionierte Caches).
    if (!('serviceWorker' in navigator)) return
    if (!import.meta.env.PROD) {
      navigator.serviceWorker.getRegistrations()
        .then(regs => regs.forEach(r => { void r.unregister() }))
        .catch(() => { /* egal */ })
      return
    }

    try {
      const reg = await navigator.serviceWorker.register(`/sw.js?v=${__APP_VERSION__}`, { scope: '/' })
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
      // Der SW fragt beim Nachsenden nach dem aktuellen Login-Token (über einen MessageChannel)
      if ((event.data as { type?: unknown } | null)?.type === 'TOKEN_ANFRAGE') {
        event.ports[0]?.postMessage({ token: this.tokenQuelle() })
        return
      }
      this.handleSwMessage(event.data)
    })

    // Initiale Queue-Größe abfragen; liegt noch etwas vom letzten Mal, gleich nachsenden
    this.requestQueueCount()
    if (navigator.onLine) this.triggerSync()
  }

  /** Observer registrieren — gibt eine Unsubscribe-Funktion zurück. */
  subscribe(fn: OfflineListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Manuellen Sync auslösen (Fallback für Browser ohne Background Sync API). */
  triggerSync(): void {
    this.anSw({ type: 'SYNC_NOW', token: this.tokenQuelle() })
  }

  /** Aktuelle Queue-Größe vom SW abfragen. */
  requestQueueCount(): void {
    this.anSw({ type: 'GET_QUEUE_COUNT' })
  }

  /** Einträge der Warteschlange abfragen (Antwort als Event QUEUE_LISTE). */
  requestQueueListe(): void {
    this.anSw({ type: 'GET_QUEUE' })
  }

  /** Einen abgelehnten Verkauf noch einmal senden (z. B. nach neuer Anmeldung). */
  erneutVersuchen(id: number): void {
    this.anSw({ type: 'ERNEUT_VERSUCHEN', id, token: this.tokenQuelle() })
  }

  /** Einen abgelehnten Verkauf bewusst verwerfen — er wird dann nicht gebucht. */
  verwerfen(id: number): void {
    this.anSw({ type: 'VERWERFEN', id })
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private anSw(nachricht: Record<string, unknown>): void {
    if (!this._swReady || !navigator.serviceWorker.controller) return
    navigator.serviceWorker.controller.postMessage(nachricht)
  }

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
        this.emit({
          type: 'BELEG_SYNC_FEHLER', id: msg.id as number, status: msg.status as number,
          ...(typeof msg.meldung === 'string' && { meldung: msg.meldung }),
        })
        break
      case 'QUEUE_LISTE':
        if (Array.isArray(msg.eintraege)) {
          const eintraege = msg.eintraege as WarteschlangenEintrag[]
          this._queueCount = eintraege.length
          this.emit({ type: 'QUEUE_LISTE', eintraege })
          this.emit({ type: 'QUEUE_COUNT', count: this._queueCount })
        }
        break
      case 'SYNC_ANMELDUNG_NOETIG':
        this.emit({ type: 'SYNC_ANMELDUNG_NOETIG' })
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
