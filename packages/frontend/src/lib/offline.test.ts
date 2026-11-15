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
/** Manager mit fester Token-Quelle (im node-Env gibt es kein localStorage) */
const neuerManager = () => new OfflineManager(() => 'TEST-TOKEN')

// ---------------------------------------------------------------------------
// Gestubbte Browser-Umgebung
// ---------------------------------------------------------------------------

interface FakeEnv {
  winListeners: Record<string, ((...a: unknown[]) => void)[]>
  swListeners:  Record<string, ((...a: unknown[]) => void)[]>
  posted:       unknown[]
  fireWindow:   (type: string, ev?: unknown) => void
  fireSwMessage: (data: unknown, ports?: Array<{ postMessage: (d: unknown) => void }>) => void
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
    fireSwMessage: (data, ports = []) => (swListeners['message'] ?? []).forEach(fn => fn({ data, ports })),
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
    expect(neuerManager().online).toBe(true)
    stubEnv({ online: false })
    expect(neuerManager().online).toBe(false)
  })

  it('startet mit leerer Queue und nicht-bereitem SW', () => {
    stubEnv()
    const m = neuerManager()
    expect(m.queueCount).toBe(0)
    expect(m.swReady).toBe(false)
  })
})

describe('OfflineManager — Observer-Pattern', () => {
  it('subscribe liefert eine Unsubscribe-Funktion; danach keine Events mehr', async () => {
    const env = stubEnv()
    const m = neuerManager()
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
    const m = neuerManager()
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
    const m = neuerManager()
    await m.init()

    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireWindow('offline')
    expect(m.online).toBe(false)
    expect(events).toContainEqual({ type: 'STATUS_CHANGE', online: false })
  })

  it('online-Event setzt Status, meldet STATUS_CHANGE und stößt Sync an', async () => {
    const env = stubEnv({ online: false })
    const m = neuerManager()
    await m.init()

    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireWindow('online')
    expect(m.online).toBe(true)
    expect(events).toContainEqual({ type: 'STATUS_CHANGE', online: true })
    // triggerSync postet SYNC_NOW an den Controller
    expect(env.posted).toContainEqual({ type: 'SYNC_NOW', token: 'TEST-TOKEN' })
  })
})

describe('OfflineManager — Queue-Zähler aus SW-Messages', () => {
  it('BELEG_QUEUED erhöht den Zähler und meldet beide Events', async () => {
    const env = stubEnv()
    const m = neuerManager()
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
    const m = neuerManager()
    await m.init()

    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 1 })
    env.fireSwMessage({ type: 'BELEG_QUEUED', id: 2 })
    expect(m.queueCount).toBe(2)

    env.fireSwMessage({ type: 'BELEG_SYNCED', id: 1, status: 201 })
    expect(m.queueCount).toBe(1)
  })

  it('BELEG_SYNCED unter 0 wird auf 0 geklemmt', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()

    env.fireSwMessage({ type: 'BELEG_SYNCED', id: 1, status: 201 })
    expect(m.queueCount).toBe(0) // nicht -1
  })

  it('QUEUE_COUNT setzt den Zähler absolut', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()

    env.fireSwMessage({ type: 'QUEUE_COUNT', count: 5 })
    expect(m.queueCount).toBe(5)
  })

  it('SYNC_DONE fragt die Queue-Größe neu an und meldet SYNC_DONE', async () => {
    const env = stubEnv()
    const m = neuerManager()
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
    const m = neuerManager()
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
    const m = neuerManager()
    await m.init()

    m.triggerSync()
    m.requestQueueCount()
    expect(env.posted).toHaveLength(0)
  })

  it('ohne Service Worker bleibt swReady false und init wirft nicht', async () => {
    stubEnv({ withSW: false })
    const m = neuerManager()
    await expect(m.init()).resolves.toBeUndefined()
    expect(m.swReady).toBe(false)
  })
})

describe('OfflineManager — Warteschlange (Prüfbericht 2026-11)', () => {
  it('beantwortet die Token-Anfrage des SW über den mitgeschickten Port — der SW speichert keinen Token', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()
    const antworten: unknown[] = []
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))

    env.fireSwMessage({ type: 'TOKEN_ANFRAGE' }, [{ postMessage: (d: unknown) => antworten.push(d) }])

    expect(antworten).toEqual([{ token: 'TEST-TOKEN' }])
    expect(events).toHaveLength(0)   // keine Weiterleitung an die Oberfläche
  })

  it('init sendet liegengebliebene Verkäufe gleich nach (online), mit Token', async () => {
    const env = stubEnv({ online: true })
    await neuerManager().init()
    expect(env.posted).toContainEqual({ type: 'SYNC_NOW', token: 'TEST-TOKEN' })
  })

  it('init offline: kein Nachsendeversuch', async () => {
    const env = stubEnv({ online: false })
    await neuerManager().init()
    expect(env.posted.some(p => (p as { type: string }).type === 'SYNC_NOW')).toBe(false)
  })

  it('QUEUE_LISTE meldet die Einträge und setzt den Zähler', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))
    const eintraege = [
      { id: 1, createdAt: 1, summeCent: 450, fehler: null },
      { id: 2, createdAt: 2, summeCent: 300, fehler: { status: 409, meldung: 'Kasse gesperrt', am: 3 } },
    ]
    env.fireSwMessage({ type: 'QUEUE_LISTE', eintraege })
    expect(events).toContainEqual({ type: 'QUEUE_LISTE', eintraege })
    expect(m.queueCount).toBe(2)
  })

  it('BELEG_SYNC_FEHLER reicht die Meldung durch, SYNC_ANMELDUNG_NOETIG wird gemeldet', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()
    const events: OfflineEvent[] = []
    m.subscribe(e => events.push(e))
    env.fireSwMessage({ type: 'BELEG_SYNC_FEHLER', id: 2, status: 409, meldung: 'Kasse gesperrt' })
    env.fireSwMessage({ type: 'SYNC_ANMELDUNG_NOETIG' })
    expect(events).toEqual([
      { type: 'BELEG_SYNC_FEHLER', id: 2, status: 409, meldung: 'Kasse gesperrt' },
      { type: 'SYNC_ANMELDUNG_NOETIG' },
    ])
  })

  it('Liste abfragen, erneut versuchen (mit Token) und verwerfen gehen als Nachricht an den SW', async () => {
    const env = stubEnv()
    const m = neuerManager()
    await m.init()
    env.posted.length = 0
    m.requestQueueListe()
    m.erneutVersuchen(7)
    m.verwerfen(8)
    expect(env.posted).toEqual([
      { type: 'GET_QUEUE' },
      { type: 'ERNEUT_VERSUCHEN', id: 7, token: 'TEST-TOKEN' },
      { type: 'VERWERFEN', id: 8 },
    ])
  })
})
