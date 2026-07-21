/**
 * Unit-Tests für den OfflineManager (Frontend-Seite des Offline-Systems).
 *
 * Getestet wird die Zustandsmaschine: Online/Offline-Status, der Queue-Zähler
 * (inkl. Clamp bei 0), das Observer-Pattern (subscribe/emit/unsubscribe), die
 * Verarbeitung der Service-Worker-Messages und die Guards (kein SW-Controller →
 * keine postMessage). Die eigentliche Queue-Persistenz/Replay liegt im Service
 * Worker und ist nicht Gegenstand dieser Tests.
 *
 * Da Vitest hier im node-Env läuft, werden navigator/window gezielt gestubbt.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { OfflineEvent } from './offline'

let OfflineManager: typeof import('./offline').OfflineManager

// ---------------------------------------------------------------------------
// Gestubbte Browser-Umgebung
// ---------------------------------------------------------------------------

interface FakeEnv {
  winListeners: Record<string, ((...a: unknown[]) => void)[]>
  swListeners:  Record<string, ((...a: unknown[]) => void)[]>
  posted:       unknown[]
  fireWindow:   (type: string, ev?: unknown) => void
  fireSwMessage: (data: unknown) => void
}

function stubEnv(opts?: { online?: boolean; withSW?: boolean; withController?: boolean }): FakeEnv {
  const winListeners: Record<string, ((...a: unknown[]) => void)[]> = {}
  const swListeners:  Record<string, ((...a: unknown[]) => void)[]> = {}
  const posted: unknown[] = []

  const controller = opts?.withController === false ? null : {
    postMessage: (m: unknown) => posted.push(m),
  }

  const serviceWorker = opts?.withSW === false ? undefined : {
    register: vi.fn().mockResolvedValue({ scope: '/' }),
    // Dev-/Test-Pfad in offline.ts räumt Alt-Registrierungen über getRegistrations() auf.
    getRegistrations: vi.fn().mockResolvedValue([]),
    addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
      (swListeners[type] ??= []).push(fn)
    },
    controller,
  }

  const navigator = { onLine: opts?.online ?? true, serviceWorker }
  const window = {
    addEventListener: (type: string, fn: (...a: unknown[]) => void) => {
      (winListeners[type] ??= []).push(fn)
    },
  }

  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('window', window)

  return {
    winListeners,
    swListeners,
    posted,
    fireWindow:    (type, ev) => (winListeners[type] ?? []).forEach(fn => fn(ev)),
    fireSwMessage: (data)     => (swListeners['message'] ?? []).forEach(fn => fn({ data })),
  }
}

beforeAll(async () => {
  // Minimal-Umgebung, damit der Modul-Import (Singleton-Konstruktion) gelingt.
  stubEnv()
  ;({ OfflineManager } = await import('./offline'))
})

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Diese Tests prüfen die SW-Message-/Sync-/Queue-Verdrahtung, die nur im
  // Produktions-Build läuft (im Dev räumt init() Alt-SWs auf und kehrt früh zurück).
  vi.stubEnv('PROD', true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OfflineManager — Konstruktion', () => {
  it('übernimmt den initialen Online-Status von navigator.onLine', () => {
    stubEnv({ online: true })
    expect(new OfflineManager().online).toBe(true)
    stubEnv({ online: false })
    expect(new OfflineManager().online).toBe(false)
  })

  it('startet mit leerer Queue und nicht-bereitem SW', () => {
    stubEnv()
    const m = new OfflineManager()
    expect(m.queueCount).toBe(0)
    expect(m.swReady).toBe(false)
  })
})

describe('OfflineManager — Observer-Pattern', () => {
  it('subscribe liefert eine Unsubscribe-Funktion; danach keine Events mehr', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()

    const events: OfflineEvent[] = []
    const unsub = m.subscribe(e => events.push(e))

    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 1 })
    expect(events.length).toBeGreaterThan(0)

    const nachSub = events.length
    unsub()
    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 2 })
    expect(events.length).toBe(nachSub) // keine weiteren Events
  })

  it('ein werfender Listener bricht die Zustellung an andere nicht ab', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()

    const gesehen: OfflineEvent[] = []
    m.subscribe(() => { throw new Error('boom') })
    m.subscribe(e => gesehen.push(e))

    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 7 })
    expect(gesehen.some(e => e.type === 'BELEG_QUEUED')).toBe(true)
  })
})

describe('OfflineManager — Online/Offline', () => {
  it('offline-Event setzt Status und meldet STATUS_CHANGE', async () => {
    const env = stubEnv({ online: true })
    const m = new OfflineManager()
    await m.init()

    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireWindow('offline')
    expect(m.online).toBe(false)
    expect(events).toContainEqual({ type: 'STATUS_CHANGE', online: false })
  })

  it('online-Event setzt Status, meldet STATUS_CHANGE und stößt Sync an', async () => {
    const env = stubEnv({ online: false })
    const m = new OfflineManager()
    await m.init()

    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireWindow('online')
    expect(m.online).toBe(true)
    expect(events).toContainEqual({ type: 'STATUS_CHANGE', online: true })
    // triggerSync postet SYNC_NOW an den Controller
    expect(env.posted).toContainEqual({ type: 'SYNC_NOW' })
  })
})

describe('OfflineManager — Queue-Zähler aus SW-Messages', () => {
  it('BELEG_QUEUED erhöht den Zähler und meldet beide Events', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 42 })

    expect(m.queueCount).toBe(1)
    expect(events).toContainEqual({ type: 'BELEG_QUEUED', id: 42 })
    expect(events).toContainEqual({ type: 'QUEUE_COUNT', count: 1 })
  })

  it('BELEG_SYNCED verringert den Zähler', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()

    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 1 })
    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 2 })
    expect(m.queueCount).toBe(2)

    env.fireSwMessage({ type: 'BELEG_SYNCED', id: 1, status: 201 })
    expect(m.queueCount).toBe(1)
  })

  it('BELEG_SYNCED unter 0 wird auf 0 geklemmt', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()

    env.fireSwMessage({ type: 'BELEG_SYNCED', id: 1, status: 201 })
    expect(m.queueCount).toBe(0) // nicht -1
  })

  it('QUEUE_COUNT setzt den Zähler absolut', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()

    env.fireSwMessage({ type: 'QUEUE_COUNT', count: 5 })
    expect(m.queueCount).toBe(5)
  })

  it('SYNC_DONE fragt die Queue-Größe neu an und meldet SYNC_DONE', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.posted.length = 0
    env.fireSwMessage({ type: 'SYNC_DONE' })

    expect(env.posted).toContainEqual({ type: 'GET_QUEUE_COUNT' })
    expect(events).toContainEqual({ type: 'SYNC_DONE' })
  })

  it('unbekannte Message-Typen werden ignoriert', async () => {
    const env = stubEnv()
    const m = new OfflineManager()
    await m.init()
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireSwMessage({ type: 'IRGENDWAS' })
    env.fireSwMessage(null)
    env.fireSwMessage('kein objekt')
    expect(events).toHaveLength(0)
    expect(m.queueCount).toBe(0)
  })
})

describe('OfflineManager — Guards', () => {
  it('ohne SW-Controller wird nichts gepostet', async () => {
    const env = stubEnv({ withController: false })
    const m = new OfflineManager()
    await m.init()

    m.triggerSync()
    m.requestQueueCount()
    expect(env.posted).toHaveLength(0)
  })

  it('ohne Service Worker bleibt swReady false und init wirft nicht', async () => {
    stubEnv({ withSW: false })
    const m = new OfflineManager()
    await expect(m.init()).resolves.toBeUndefined()
    expect(m.swReady).toBe(false)
  })
})
