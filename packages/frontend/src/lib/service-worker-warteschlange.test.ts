/**
 * Verhaltenstests für die Offline-Warteschlange des Kassa-Service-Workers (public/sw.js).
 *
 * Hintergrund (Prüfbericht 2026-11, RKSV): Die Warteschlange nahm JEDEN POST auf /api/belege/* auf
 * (auch Storno, Sonderbelege, FinanzOnline-Registrierung samt PIN), speicherte den Login-Token mit,
 * schickte ohne Idempotenz-Schlüssel nach (Doppelbeleg bei verlorener Antwort), löschte bei 409 den
 * Verkauf still und wiederholte 400/401/403 endlos. Diese Tests halten das neue Verhalten fest.
 *
 * Der echte SW-Code läuft in einem node:vm-Kontext mit nachgebautem `self`, IndexedDB, Clients und
 * MessageChannel.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const BASIS = 'https://kasse.example'
const SW = new URL('../../public/sw.js', import.meta.url)
const SCHLUESSEL = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

type Handler = (e: unknown) => void
type Eintrag = Record<string, unknown> & { id: number }

/** Minimal-IndexedDB: genau die Aufrufe, die sw.js macht (open, Store add/put/get/getAll/delete) */
function fakeIndexedDb() {
  const stores = new Map<string, { naechsteId: number; daten: Map<number, Eintrag> }>()
  function anfrage<T>(arbeit: () => T) {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {}
    queueMicrotask(() => {
      try { r.result = arbeit(); r.onsuccess?.() } catch (e) { r.error = e; r.onerror?.() }
    })
    return r
  }
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => {
      stores.set(n, { naechsteId: 1, daten: new Map() })
      return { createIndex: () => {} }
    },
    transaction: (n: string) => ({
      objectStore: () => {
        const s = stores.get(n)!
        return {
          add:    (v: Omit<Eintrag, 'id'>) => anfrage(() => { const id = s.naechsteId++; s.daten.set(id, structuredClone({ ...v, id })); return id }),
          put:    (v: Eintrag) => anfrage(() => { s.daten.set(v.id, structuredClone(v)); return v.id }),
          get:    (id: number) => anfrage(() => structuredClone(s.daten.get(id))),
          getAll: () => anfrage(() => [...s.daten.keys()].sort((a, b) => a - b).map(k => structuredClone(s.daten.get(k)!))),
          delete: (id: number) => anfrage(() => { s.daten.delete(id) }),
        }
      },
    }),
  }
  const indexedDB = {
    open: () => {
      const r: { result?: unknown; onupgradeneeded?: (e: unknown) => void; onsuccess?: (e: unknown) => void } = {}
      queueMicrotask(() => {
        if (stores.size === 0) r.onupgradeneeded?.({ target: { result: db } })
        r.result = db
        r.onsuccess?.({ target: { result: db } })
      })
      return r
    },
  }
  /** Einträge direkt (wie von einer älteren SW-Version) anlegen */
  function legeAn(eintrag: Omit<Eintrag, 'id'>): number {
    if (!stores.has('offline-queue')) db.createObjectStore('offline-queue')
    const s = stores.get('offline-queue')!
    const id = s.naechsteId++
    s.daten.set(id, structuredClone({ ...eintrag, id }))
    return id
  }
  const eintraege = () => [...(stores.get('offline-queue')?.daten.values() ?? [])]
  return { indexedDB, legeAn, eintraege }
}

/** MessageChannel-Nachbau: port2 geht an die Seite, deren Antwort landet bei port1.onmessage */
class FakeChannel {
  port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null }
  port2 = { postMessage: (d: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data: d })) }
}

/** Eine Seite der Kassa (Window-Client): sammelt Nachrichten, beantwortet die Token-Anfrage */
function seite(token: string | null) {
  const nachrichten: Array<Record<string, unknown>> = []
  return {
    nachrichten,
    postMessage: (m: Record<string, unknown>, ports?: Array<{ postMessage: (d: unknown) => void }>) => {
      if (m.type === 'TOKEN_ANFRAGE') ports?.[0]?.postMessage({ token })
      else nachrichten.push(m)
    },
    typen: () => nachrichten.map(n => n.type),
  }
}

function ladeSw({ token = 'TOKEN-AKTUELL' as string | null, mitSeite = true } = {}) {
  const handler: Record<string, Handler[]> = {}
  const idb = fakeIndexedDb()
  const fetch = vi.fn<(r: unknown, init?: RequestInit) => Promise<Response>>()
  const client = seite(token)
  const self = {
    location: new URL(BASIS + '/sw.js?v=1.2.3'),
    addEventListener: (typ: string, h: Handler) => { (handler[typ] ??= []).push(h) },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}), matchAll: async () => (mitSeite ? [client] : []) },
  }
  const caches = { keys: async () => [], delete: async () => true, open: async () => ({ addAll: async () => {} }), match: async () => undefined }
  vm.runInNewContext(readFileSync(SW, 'utf8'), {
    self, caches, fetch, Request, Response, Headers, URL, URLSearchParams, AbortController,
    indexedDB: idb.indexedDB, MessageChannel: FakeChannel,
    // Zeitlimits gestaucht (Faktor 1/100), damit der Test nicht 10 s auf das Verkaufs-Zeitlimit wartet
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms / 100),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    console,
  })

  /** POST über den SW; antwort = undefined ⇒ der SW hat nicht übernommen */
  function posten(pfad: string, headers: Record<string, string>, body: unknown): { antwort?: Promise<Response> } {
    const request = new Request(new URL(pfad, BASIS).href, { method: 'POST', headers, body: JSON.stringify(body) })
    let antwort: Promise<Response> | undefined
    for (const h of handler.fetch ?? []) {
      h({ request, respondWith: (p: Promise<Response>) => { antwort = Promise.resolve(p) }, waitUntil: () => {} })
    }
    return antwort ? { antwort } : {}
  }

  /** Nachricht der Seite an den SW */
  function nachricht(data: Record<string, unknown>) {
    for (const h of handler.message ?? []) h({ data, source: client })
  }

  async function syncEreignis() {
    const warten: Promise<unknown>[] = []
    for (const h of handler.sync ?? []) h({ tag: 'kassa-beleg-sync', waitUntil: (p: Promise<unknown>) => warten.push(p) })
    await Promise.all(warten)
  }

  async function aktivieren() {
    const warten: Promise<unknown>[] = []
    for (const h of handler.activate ?? []) h({ waitUntil: (p: Promise<unknown>) => warten.push(p) })
    await Promise.all(warten)
  }

  /** Bis der SW eine Nachricht dieses Typs an die Seite geschickt hat (n-tes Vorkommen) */
  async function warteAuf(typ: string, anzahl = 1) {
    await vi.waitFor(() => {
      expect(client.typen().filter(t => t === typ).length).toBeGreaterThanOrEqual(anzahl)
    })
  }

  return { fetch, idb, client, posten, nachricht, syncEreignis, aktivieren, warteAuf }
}

const VERKAUF = {
  kasseId: '00000000-0000-4000-8000-000000000001',
  positionen: [{ artikelId: '00000000-0000-4000-8000-000000000002', menge: 2 }],
  zahlung: { barCent: 450, karteCent: 0, sonstigeCent: 0 },
}
const VERKAUF_HEADER = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer TOKEN-BEIM-VERKAUF',
  'Idempotency-Key': SCHLUESSEL,
  'X-Kassa-Offline': 'puffern',
}

const netzWeg = () => Promise.reject(new TypeError('Failed to fetch'))
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

/** Einen Verkauf offline erfassen (Netz weg → Warteschlange) */
async function offlineVerkauf(sw: ReturnType<typeof ladeSw>, schluessel = SCHLUESSEL, barCent = 450) {
  sw.fetch.mockImplementationOnce(netzWeg)
  const res = await sw.posten('/api/belege/barzahlung', { ...VERKAUF_HEADER, 'Idempotency-Key': schluessel },
    { ...VERKAUF, zahlung: { barCent, karteCent: 0, sonstigeCent: 0 } }).antwort!
  expect(res.status).toBe(202)
}

describe('Service Worker Kassa: Offline-Warteschlange', () => {
  it('Verkauf bei Netzausfall: 202 mit _offline, gespeichert OHNE Login-Token, mit Idempotency-Key und Summe', async () => {
    const sw = ladeSw()
    sw.fetch.mockImplementationOnce(netzWeg)
    const res = await sw.posten('/api/belege/barzahlung', VERKAUF_HEADER, VERKAUF).antwort!
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ _offline: true, _queueId: 1 })

    const [e] = sw.idb.eintraege()
    expect(e!.headers).toEqual({ 'content-type': 'application/json', 'idempotency-key': SCHLUESSEL })
    expect(JSON.stringify(e)).not.toContain('TOKEN-BEIM-VERKAUF')
    expect(e!.summeCent).toBe(450)
    expect(e!.fehler).toBeNull()
    await sw.warteAuf('BELEG_QUEUED')
  })

  it('hängendes Netz: nach dem Zeitlimit wird die Anfrage abgebrochen und der Verkauf gepuffert', async () => {
    const sw = ladeSw()
    let signal: AbortSignal | undefined
    sw.fetch.mockImplementationOnce((_r, init) => new Promise<Response>((_ok, fehler) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => fehler(new DOMException('abgebrochen', 'AbortError')))
    }))
    const res = await sw.posten('/api/belege/barzahlung', VERKAUF_HEADER, VERKAUF).antwort!
    expect(signal?.aborted).toBe(true)
    expect(res.status).toBe(202)
    expect(sw.idb.eintraege()).toHaveLength(1)
  })

  it('online: der Verkauf geht direkt durch, nichts wird gespeichert', async () => {
    const sw = ladeSw()
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    const res = await sw.posten('/api/belege/barzahlung', VERKAUF_HEADER, VERKAUF).antwort!
    expect(res.status).toBe(201)
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it.each([
    ['Storno',                         '/api/belege/storno',           VERKAUF_HEADER],
    ['Monatsbeleg',                    '/api/belege/monatsbeleg',      VERKAUF_HEADER],
    ['FinanzOnline-Registrierung',     '/api/belege/fo-registrierung', VERKAUF_HEADER],
    ['Verkauf ohne Idempotency-Key',   '/api/belege/barzahlung',       { ...VERKAUF_HEADER, 'Idempotency-Key': '' }],
    ['Verkauf ohne Puffer-Freigabe',   '/api/belege/barzahlung',       { 'Content-Type': 'application/json', 'Idempotency-Key': SCHLUESSEL }],
  ])('%s geht nie über die Warteschlange (offline schlägt er sofort fehl)', (_name, pfad, headers) => {
    const sw = ladeSw()
    expect(sw.posten(pfad, headers, { kasseId: VERKAUF.kasseId, credentials: { pin: 'GEHEIM' } }).antwort).toBeUndefined()
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it('Nachsenden: Token frisch von der Seite, derselbe Idempotency-Key, Erfolg entfernt den Eintrag', async () => {
    const sw = ladeSw({ token: 'TOKEN-NEU' })
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))

    await sw.syncEreignis()

    const [url, init] = sw.fetch.mock.calls.at(-1)!
    expect(url).toBe(BASIS + '/api/belege/barzahlung')
    expect(init!.headers).toEqual({
      'content-type': 'application/json', 'idempotency-key': SCHLUESSEL, authorization: 'Bearer TOKEN-NEU',
    })
    expect(JSON.parse(init!.body as string)).toEqual(VERKAUF)
    expect(sw.idb.eintraege()).toHaveLength(0)
    await sw.warteAuf('BELEG_SYNCED')
  })

  it('schon gebucht (Antwort war verloren): 200 vom Backend zählt als Erfolg', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(200, { id: 'b1' }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it('SYNC_NOW der Seite bringt den Token mit — dann keine Rückfrage nötig', async () => {
    const sw = ladeSw({ token: null })   // Seite würde auf die Anfrage keinen Token liefern
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    sw.nachricht({ type: 'SYNC_NOW', token: 'TOKEN-AUS-SYNC-NOW' })
    await sw.warteAuf('SYNC_DONE')
    expect((sw.fetch.mock.calls.at(-1)![1]!.headers as Record<string, string>).authorization).toBe('Bearer TOKEN-AUS-SYNC-NOW')
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it('ohne angemeldete Seite: nichts wird gesendet, die Seite erfährt, dass eine Anmeldung nötig ist', async () => {
    const sw = ladeSw({ token: null })
    await offlineVerkauf(sw)
    await sw.syncEreignis()
    expect(sw.fetch).toHaveBeenCalledTimes(1)   // nur der gescheiterte Verkauf selbst
    expect(sw.idb.eintraege()).toHaveLength(1)
    await sw.warteAuf('SYNC_ANMELDUNG_NOETIG')
  })

  it('401 beim Nachsenden: Eintrag bleibt unmarkiert stehen, der Lauf bricht ab', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw, SCHLUESSEL)
    await offlineVerkauf(sw, '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b')
    sw.fetch.mockResolvedValueOnce(json(401, { fehler: 'Token abgelaufen' }))
    await sw.syncEreignis()
    expect(sw.fetch).toHaveBeenCalledTimes(3)   // 2 Verkäufe + 1 Nachsendeversuch, der zweite nicht mehr
    expect(sw.idb.eintraege().map(e => e.fehler)).toEqual([null, null])
    await sw.warteAuf('SYNC_ANMELDUNG_NOETIG')
  })

  it('409 (fachlich abgelehnt): NICHT gelöscht, mit Grund markiert; der nächste Verkauf wird trotzdem gebucht', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw, SCHLUESSEL, 450)
    await offlineVerkauf(sw, '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', 300)
    sw.fetch
      .mockResolvedValueOnce(json(409, { fehler: 'Seriennummer schon verkauft' }))
      .mockResolvedValueOnce(json(201, { id: 'b2' }))
    await sw.syncEreignis()

    const rest = sw.idb.eintraege()
    expect(rest).toHaveLength(1)
    expect(rest[0]!.summeCent).toBe(450)
    expect(rest[0]!.fehler).toMatchObject({ status: 409, meldung: 'Seriennummer schon verkauft' })
    await vi.waitFor(() => expect(sw.client.nachrichten).toContainEqual(
      expect.objectContaining({ type: 'BELEG_SYNC_FEHLER', status: 409, meldung: 'Seriennummer schon verkauft' }),
    ))

    // Ein weiterer Lauf lässt den markierten Verkauf in Ruhe (keine Endlosschleife)
    const vorher = sw.fetch.mock.calls.length
    await sw.syncEreignis()
    expect(sw.fetch.mock.calls.length).toBe(vorher)
  })

  it.each([400, 403, 404])('%i wird ebenfalls markiert statt endlos wiederholt', async (status) => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(status, { fehler: 'abgelehnt' }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()[0]!.fehler).toMatchObject({ status })
  })

  it.each([500, 503, 429])('%i (Server nicht bereit): bleibt offen und unmarkiert, später erneut', async (status) => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(status, { fehler: 'kurz weg' }))
    await sw.syncEreignis()
    const [e] = sw.idb.eintraege()
    expect(e!.fehler).toBeNull()
    expect(e!.versuche).toBe(1)
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it('Netz beim Nachsenden noch weg: Eintrag bleibt, Lauf endet still', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockImplementationOnce(netzWeg)
    await sw.syncEreignis()
    expect(sw.idb.eintraege()).toHaveLength(1)
    expect(sw.idb.eintraege()[0]!.fehler).toBeNull()
  })

  it('ERNEUT_VERSUCHEN hebt die Markierung auf und sendet; VERWERFEN löscht', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw, SCHLUESSEL)
    await offlineVerkauf(sw, '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b')
    sw.fetch
      .mockResolvedValueOnce(json(409, { fehler: 'Kasse gesperrt' }))
      .mockResolvedValueOnce(json(409, { fehler: 'Kasse gesperrt' }))
    await sw.syncEreignis()
    const [a, b] = sw.idb.eintraege()
    expect(a!.fehler).not.toBeNull()
    expect(b!.fehler).not.toBeNull()

    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    sw.nachricht({ type: 'ERNEUT_VERSUCHEN', id: a!.id, token: 'TOKEN-AKTUELL' })
    await sw.warteAuf('SYNC_DONE')
    expect(sw.idb.eintraege().map(e => e.id)).toEqual([b!.id])

    sw.nachricht({ type: 'VERWERFEN', id: b!.id })
    await sw.warteAuf('SYNC_DONE', 2)
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  it('GET_QUEUE liefert die Einträge zur Anzeige — ohne Body (der kann einen Freigabe-PIN tragen)', async () => {
    const sw = ladeSw()
    sw.fetch.mockImplementationOnce(netzWeg)
    await sw.posten('/api/belege/barzahlung', VERKAUF_HEADER, { ...VERKAUF, freigabePin: '4711' }).antwort
    sw.nachricht({ type: 'GET_QUEUE' })
    await sw.warteAuf('QUEUE_LISTE')
    const liste = sw.client.nachrichten.find(n => n.type === 'QUEUE_LISTE')!
    expect(liste.eintraege).toEqual([{ id: 1, createdAt: expect.any(Number), summeCent: 450, fehler: null, nurVerwerfen: false }])
    expect(JSON.stringify(liste)).not.toContain('4711')
  })

  it('sync-Ereignis und SYNC_NOW gleichzeitig: jeder Verkauf wird nur einmal gesendet', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    let freigeben!: (r: Response) => void
    sw.fetch.mockImplementationOnce(() => new Promise<Response>(r => { freigeben = r }))
    const lauf = sw.syncEreignis()
    sw.nachricht({ type: 'SYNC_NOW', token: 'TOKEN-AKTUELL' })
    await vi.waitFor(() => expect(freigeben).toBeTypeOf('function'))
    freigeben(json(201, { id: 'b1' }))
    await lauf
    await sw.warteAuf('SYNC_DONE')
    expect(sw.fetch).toHaveBeenCalledTimes(2)   // Verkauf + genau ein Nachsenden
  })

  it('403 „Freigabe erforderlich": die Meldung sagt, dass nur Verwerfen und neu Kassieren hilft', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockResolvedValueOnce(json(403, { fehler: 'Rabatt braucht eine Freigabe', code: 'freigabe_erforderlich' }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()[0]!.fehler).toMatchObject({
      status: 403, meldung: expect.stringMatching(/^Rabatt braucht eine Freigabe — .*neu kassieren/),
    })
  })

  it('„Erneut senden" während eines laufenden Durchgangs: danach läuft noch einer und sendet ihn', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw, SCHLUESSEL)
    await offlineVerkauf(sw, '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b')
    sw.fetch.mockResolvedValueOnce(json(409, { fehler: 'Kasse gesperrt' }))   // erster abgelehnt
    let freigeben!: (r: Response) => void
    sw.fetch.mockImplementationOnce(() => new Promise<Response>(r => { freigeben = r }))   // zweiter hängt
    const lauf = sw.syncEreignis()
    await vi.waitFor(() => expect(freigeben).toBeTypeOf('function'))

    const ersterId = sw.idb.eintraege()[0]!.id
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    sw.nachricht({ type: 'ERNEUT_VERSUCHEN', id: ersterId, token: 'TOKEN-AKTUELL' })
    freigeben(json(201, { id: 'b2' }))
    await lauf
    await sw.warteAuf('SYNC_DONE')
    await vi.waitFor(() => expect(sw.idb.eintraege()).toHaveLength(0))
  })

  it('Nachsenden hängt: nach dem Zeitlimit abgebrochen, der Eintrag bleibt, der nächste Lauf geht wieder', async () => {
    const sw = ladeSw()
    await offlineVerkauf(sw)
    sw.fetch.mockImplementationOnce((_u, init) => new Promise<Response>((_ok, fehler) => {
      init?.signal?.addEventListener('abort', () => fehler(new DOMException('abgebrochen', 'AbortError')))
    }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()).toHaveLength(1)
    sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
    await sw.syncEreignis()
    expect(sw.idb.eintraege()).toHaveLength(0)
  })

  describe('Altbestand einer älteren SW-Version (beim Aktivieren bereinigt)', () => {
    const alterEintrag = (pfad: string, body: unknown, extraHeader: Record<string, string> = {}) => ({
      url: BASIS + pfad, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ALT-TOKEN', ...extraHeader },
      body: JSON.stringify(body), createdAt: 1, versuche: 0,
    })

    it('Verkauf ohne Schlüssel: Token weg, markiert (kein Doppelschutz) — nie ungefragt gesendet', async () => {
      const sw = ladeSw()
      sw.idb.legeAn(alterEintrag('/api/belege/barzahlung', VERKAUF))
      await sw.aktivieren()
      const [e] = sw.idb.eintraege()
      expect(e!.headers).toEqual({ 'content-type': 'application/json' })
      expect(e!.summeCent).toBe(450)
      expect(e!.fehler).toMatchObject({ status: 0, meldung: expect.stringMatching(/Belegliste prüfen/) })
      expect(JSON.stringify(e)).not.toContain('ALT-TOKEN')

      await sw.syncEreignis()
      expect(sw.fetch).not.toHaveBeenCalled()

      // Der Kassier hat geprüft und schickt ihn bewusst
      sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
      sw.nachricht({ type: 'ERNEUT_VERSUCHEN', id: e!.id, token: 'TOKEN-AKTUELL' })
      await sw.warteAuf('SYNC_DONE')
      expect(sw.idb.eintraege()).toHaveLength(0)
    })

    it('Storno/FinanzOnline-Registrierung: Inhalt (PIN) gelöscht, nur noch Verwerfen — auch „Erneut senden" sendet nichts', async () => {
      const sw = ladeSw()
      sw.idb.legeAn(alterEintrag('/api/belege/fo-registrierung', { kasseId: VERKAUF.kasseId, credentials: { pin: 'FON-GEHEIM' } }))
      sw.idb.legeAn(alterEintrag('/api/belege/storno', { belegId: 'x' }))
      await sw.aktivieren()
      for (const e of sw.idb.eintraege()) {
        expect(e.body).toBeNull()
        expect(e.nurVerwerfen).toBe(true)
        expect(e.fehler).toMatchObject({ status: 0, meldung: expect.stringMatching(/älteren Version/) })
      }
      expect(JSON.stringify(sw.idb.eintraege())).not.toMatch(/FON-GEHEIM|ALT-TOKEN/)

      const [fo] = sw.idb.eintraege()
      sw.nachricht({ type: 'ERNEUT_VERSUCHEN', id: fo!.id, token: 'TOKEN-AKTUELL' })
      await sw.warteAuf('SYNC_DONE')
      expect(sw.fetch).not.toHaveBeenCalled()
      expect(sw.idb.eintraege()).toHaveLength(2)

      sw.nachricht({ type: 'GET_QUEUE' })
      await sw.warteAuf('QUEUE_LISTE')
      const liste = sw.client.nachrichten.find(n => n.type === 'QUEUE_LISTE')!
      expect((liste.eintraege as Array<{ nurVerwerfen: boolean }>).every(x => x.nurVerwerfen)).toBe(true)
    })

    it('Verkauf, der schon einen Schlüssel trug: nur der Token fällt weg, er wird normal nachgesendet', async () => {
      const sw = ladeSw()
      sw.idb.legeAn(alterEintrag('/api/belege/barzahlung', VERKAUF, { 'idempotency-key': SCHLUESSEL }))
      await sw.aktivieren()
      expect(sw.idb.eintraege()[0]!.fehler).toBeNull()
      sw.fetch.mockResolvedValueOnce(json(201, { id: 'b1' }))
      await sw.syncEreignis()
      expect((sw.fetch.mock.calls[0]![1]!.headers as Record<string, string>)['idempotency-key']).toBe(SCHLUESSEL)
      expect(sw.idb.eintraege()).toHaveLength(0)
    })
  })
})
