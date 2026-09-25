/**
 * Verhaltenstests für die Service Worker der Kassa (public/sw.js) und der
 * Kellner-App (../kellner/public/sw.js) — hier gemeinsam, weil beide Apps den
 * Seitenaufruf gleich behandeln müssen und nur dieses Paket einen Test-Runner hat.
 *
 * Der echte SW-Code läuft in einem node:vm-Kontext mit nachgebautem `self`,
 * CacheStorage und fetch. Kern ist der Seitenaufruf: NETZ ZUERST (sonst lieferte
 * der alte SW nach einem Update ewig die alte Seite, die wiederum den alten SW
 * registrierte), mit Zeitlimit und festem Cache-Schlüssel /index.html.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BASIS = 'https://kasse.example'

// Echte Request-Objekte kennen mode 'navigate' nicht (Konstruktor wirft) — daher ein Nachbau
type Anfrage = { url: string; method: string; mode: string; clone: () => Anfrage }
type Handler = (e: unknown) => void

class FakeCache {
  readonly eintraege = new Map<string, Response>()
  constructor(private readonly holen: (r: unknown, init?: RequestInit) => Promise<Response>) {}
  private schluessel(r: string | { url: string }): string {
    return typeof r === 'string' ? new URL(r, BASIS).href : r.url
  }
  async match(r: string | { url: string }) { return this.eintraege.get(this.schluessel(r))?.clone() }
  async put(r: string | { url: string }, res: Response) { this.eintraege.set(this.schluessel(r), res) }
  async delete(r: string | { url: string }) { return this.eintraege.delete(this.schluessel(r)) }
  async addAll(anfragen: Request[]) {
    for (const r of anfragen) {
      const res = await this.holen(r)
      if (!res.ok) throw new TypeError('addAll: ' + res.status)
      await this.put(r, res)
    }
  }
}

/** Lädt eine sw.js in eine nachgebaute SW-Umgebung (Version 1.2.3). */
function ladeSw(datei: URL) {
  const handler: Record<string, Handler[]> = {}
  const caches = new Map<string, FakeCache>()
  const fetch = vi.fn<(r: unknown, init?: RequestInit) => Promise<Response>>()
  const cacheStorage = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new FakeCache((r, init) => fetch(r, init)))
      return caches.get(name)!
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
    match: async (r: string | { url: string }) => {
      for (const c of caches.values()) {
        const treffer = await c.match(r)
        if (treffer) return treffer
      }
      return undefined
    },
  }
  // Relative URLs wie im Browser gegen die SW-Adresse auflösen
  class SwRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, BASIS).href : input, init)
    }
  }
  const self = {
    location: new URL(BASIS + '/sw.js?v=1.2.3'),
    addEventListener: (typ: string, h: Handler) => { (handler[typ] ??= []).push(h) },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}), matchAll: async () => [] },
  }
  vm.runInNewContext(readFileSync(datei, 'utf8'), {
    self, caches: cacheStorage, fetch, Request: SwRequest, Response, Headers, URL, URLSearchParams,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    console,
  })

  /** fetch-Ereignis auslösen; antwort = undefined ⇒ der SW hat nicht übernommen. */
  function abrufen(pfad: string, mode = 'cors'): { antwort?: Promise<Response> } {
    const request: Anfrage = { url: new URL(pfad, BASIS).href, method: 'GET', mode, clone: () => request }
    let antwort: Promise<Response> | undefined
    for (const h of handler.fetch ?? []) {
      h({ request, respondWith: (p: Promise<Response>) => { antwort = Promise.resolve(p) }, waitUntil: () => {} })
    }
    return antwort ? { antwort } : {}
  }

  async function lebenszyklus(typ: 'install' | 'activate') {
    const warten: Promise<unknown>[] = []
    for (const h of handler[typ] ?? []) h({ waitUntil: (p: Promise<unknown>) => warten.push(p) })
    await Promise.all(warten)
  }

  return { fetch, caches, cacheStorage, self, abrufen, lebenszyklus }
}

const html = (text: string) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/html' } })

const APPS = [
  { app: 'Kassa',   datei: new URL('../../public/sw.js', import.meta.url),            cache: 'kassa-1.2.3-static' },
  { app: 'Kellner', datei: new URL('../../../kellner/public/sw.js', import.meta.url), cache: 'kellner-1.2.3' },
]

describe.each(APPS)('Service Worker $app', ({ datei, cache }) => {
  let sw: ReturnType<typeof ladeSw>
  const gespeicherteSeite = async () => (await sw.cacheStorage.match('/index.html'))?.text()

  beforeEach(() => { sw = ladeSw(datei) })
  afterEach(() => { vi.useRealTimers() })

  it('Seitenaufruf: Netz zuerst, am HTTP-Cache vorbei, abgelegt unter /index.html', async () => {
    await (await sw.cacheStorage.open(cache)).put('/index.html', html('alte Seite'))
    sw.fetch.mockResolvedValue(html('neue Seite'))

    const { antwort } = sw.abrufen('/tab/7?kasse=bar', 'navigate')
    expect(await (await antwort!).text()).toBe('neue Seite')
    expect(sw.fetch.mock.calls[0]![1]).toEqual({ cache: 'no-cache' })

    await vi.waitFor(async () => expect(await gespeicherteSeite()).toBe('neue Seite'))
    expect(await sw.cacheStorage.match('/tab/7?kasse=bar')).toBeUndefined()
  })

  it('offline: App-Hülle aus dem Cache — auch für eine nie besuchte URL', async () => {
    await (await sw.cacheStorage.open(cache)).put('/index.html', html('Hülle'))
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))

    const { antwort } = sw.abrufen('/nie/besucht?x=1', 'navigate')
    expect(await (await antwort!).text()).toBe('Hülle')
  })

  it('Netz hängt: nach 4 s die Hülle aus dem Cache, die späte Antwort frischt den Cache auf', async () => {
    vi.useFakeTimers()
    await (await sw.cacheStorage.open(cache)).put('/index.html', html('Hülle'))
    let netzAntwort!: (r: Response) => void
    sw.fetch.mockReturnValue(new Promise<Response>(ok => { netzAntwort = ok }))

    const { antwort } = sw.abrufen('/', 'navigate')
    let fertig: string | undefined
    void antwort!.then(r => r.text()).then(t => { fertig = t })
    await vi.advanceTimersByTimeAsync(3900)
    expect(fertig).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    await vi.waitFor(() => expect(fertig).toBe('Hülle'))

    netzAntwort(html('neue Seite'))
    await vi.waitFor(async () => expect(await gespeicherteSeite()).toBe('neue Seite'))
  })

  it('Netz hängt, nichts im Cache: weiter aufs Netz warten statt Fehlerseite', async () => {
    vi.useFakeTimers()
    let netzAntwort!: (r: Response) => void
    sw.fetch.mockReturnValue(new Promise<Response>(ok => { netzAntwort = ok }))

    const { antwort } = sw.abrufen('/', 'navigate')
    let fertig: string | undefined
    void antwort!.then(r => r.text()).then(t => { fertig = t })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fertig).toBeUndefined()
    netzAntwort(html('neue Seite'))
    await vi.waitFor(() => expect(fertig).toBe('neue Seite'))
  })

  it('Fehlerseite vom Server wird durchgereicht, aber nicht als Hülle gespeichert', async () => {
    await (await sw.cacheStorage.open(cache)).put('/index.html', html('Hülle'))
    sw.fetch.mockResolvedValue(new Response('kaputt', { status: 502 }))

    const { antwort } = sw.abrufen('/', 'navigate')
    expect((await antwort!).status).toBe(502)
    expect(await gespeicherteSeite()).toBe('Hülle')
  })

  it('SSE-Strom geht nie über den SW (ein gecachter Strom würde endlos wiederholt)', () => {
    expect(sw.abrufen('/sse/events?token=x').antwort).toBeUndefined()
  })

  it('gehashte Assets: Cache zuerst', async () => {
    sw.fetch.mockResolvedValue(new Response('js', { status: 200 }))
    expect(await (await sw.abrufen('/assets/index-abc123.js').antwort!).text()).toBe('js')
    await vi.waitFor(async () => expect(await sw.cacheStorage.match('/assets/index-abc123.js')).toBeDefined())

    sw.fetch.mockClear()
    expect(await (await sw.abrufen('/assets/index-abc123.js').antwort!).text()).toBe('js')
    expect(sw.fetch).not.toHaveBeenCalled()
  })

  it('install: Hülle vorab frisch vom Server (cache: no-cache), dann sofort aktiv', async () => {
    sw.fetch.mockImplementation(async () => html('Hülle'))
    await sw.lebenszyklus('install')

    const angefragt = sw.fetch.mock.calls.map(([r]) => r as Request)
    const seite = angefragt.find(r => new URL(r.url).pathname === '/index.html')
    expect(seite?.cache).toBe('no-cache')
    expect(await gespeicherteSeite()).toBe('Hülle')
    expect(sw.self.skipWaiting).toHaveBeenCalled()
  })

  it('install: scheitert der Vorab-Cache, wird der neue SW trotzdem aktiv', async () => {
    sw.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await sw.lebenszyklus('install')
    expect(sw.self.skipWaiting).toHaveBeenCalled()
  })

  it('activate: Caches anderer Versionen weg, eigener bleibt, SW übernimmt die Seiten', async () => {
    const alt = cache.replace('1.2.3', '1.2.2')
    await sw.cacheStorage.open(alt)
    await sw.cacheStorage.open(cache)
    await sw.cacheStorage.open('fremd')
    await sw.lebenszyklus('activate')

    expect(await sw.cacheStorage.keys()).toEqual([cache, 'fremd'])
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })
})

describe('Service Worker Kellner: API', () => {
  it('geht nie über den SW', () => {
    const sw = ladeSw(APPS[1]!.datei)
    expect(sw.abrufen('/api/tische').antwort).toBeUndefined()
  })
})
