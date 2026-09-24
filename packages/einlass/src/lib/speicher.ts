/**
 * Offline-Speicher der Einlass-App (IndexedDB): je Event die Ticketliste (Codes
 * nur als SHA-256) und die Warteschlange der offline entschiedenen Scans.
 *
 * Ohne IndexedDB (privater Modus, sehr alter Browser) läuft der Einlass online
 * weiter — nur der Offline-Rückfall fehlt; die App zeigt das an.
 */

import type {
  EinlassErgebnisArt,
  EinlassOfflineListe,
  EinlassOfflineTicket,
  TicketBand,
  TicketEinlassStand,
  TicketEventStatus,
} from '@kassa/shared'

const DB_NAME = 'kassa-einlass'
const DB_VERSION = 1

export interface ListenMeta {
  eventId:    string
  /** Serverzeit der zuletzt geladenen Liste (Grundlage für ?seit=) */
  erstelltAt: string
  event:      { titel: string; beginn: string; status: TicketEventStatus }
  baender:    TicketBand[]
  /** Letzter Stand vom Server (Besucherzahl) */
  stand:      TicketEinlassStand
}

export interface WartenderScan {
  scanId:    string
  eventId:   string
  inhalt:    string
  zeitpunkt: string
  lokal:     EinlassErgebnisArt
  /** Hat dieser Scan offline einen neuen Besucher gezählt? (für die Anzeige bis zum Abgleich) */
  neuerBesucher: boolean
}

interface GespeichertesTicket extends EinlassOfflineTicket {
  /** `${eventId}|${h}` */
  k:       string
  eventId: string
}

let dbVersprechen: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbVersprechen) {
    dbVersprechen = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('Kein IndexedDB')); return }
      const anfrage = indexedDB.open(DB_NAME, DB_VERSION)
      anfrage.onupgradeneeded = () => {
        const d = anfrage.result
        d.createObjectStore('meta', { keyPath: 'eventId' })
        d.createObjectStore('tickets', { keyPath: 'k' }).createIndex('event', 'eventId')
        d.createObjectStore('warteschlange', { keyPath: 'scanId' }).createIndex('event', 'eventId')
      }
      anfrage.onsuccess = () => resolve(anfrage.result)
      anfrage.onerror   = () => reject(anfrage.error ?? new Error('IndexedDB nicht verfügbar'))
    })
    dbVersprechen.catch(() => { dbVersprechen = null })
  }
  return dbVersprechen
}

function ergebnis<T>(anfrage: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    anfrage.onsuccess = () => resolve(anfrage.result)
    anfrage.onerror   = () => reject(anfrage.error)
  })
}

function abgeschlossen(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
    tx.onabort    = () => reject(tx.error ?? new Error('Transaktion abgebrochen'))
  })
}

const bereich = (eventId: string) => IDBKeyRange.only(eventId)

/** Ist Offline-Speicher auf diesem Gerät nutzbar? */
export async function speicherVerfuegbar(): Promise<boolean> {
  try { await db(); return true } catch { return false }
}

export async function ladeListe(eventId: string): Promise<{ meta: ListenMeta; tickets: Map<string, EinlassOfflineTicket> } | null> {
  const d = await db()
  const tx = d.transaction(['meta', 'tickets'], 'readonly')
  const meta = await ergebnis(tx.objectStore('meta').get(eventId) as IDBRequest<ListenMeta | undefined>)
  if (!meta) return null
  const zeilen = await ergebnis(tx.objectStore('tickets').index('event').getAll(bereich(eventId)) as IDBRequest<GespeichertesTicket[]>)
  const tickets = new Map<string, EinlassOfflineTicket>()
  for (const { k: _k, eventId: _e, ...t } of zeilen) tickets.set(t.h, t)
  return { meta, tickets }
}

/** Liste übernehmen: vollständig = ersetzen, sonst geänderte Tickets einarbeiten. */
export async function speichereListe(liste: EinlassOfflineListe): Promise<void> {
  const d = await db()
  const tx = d.transaction(['meta', 'tickets'], 'readwrite')
  const store = tx.objectStore('tickets')
  if (liste.vollstaendig) {
    const alte = await ergebnis(store.index('event').getAllKeys(bereich(liste.eventId)))
    for (const k of alte) store.delete(k)
  }
  for (const t of liste.tickets) store.put({ ...t, k: `${liste.eventId}|${t.h}`, eventId: liste.eventId } satisfies GespeichertesTicket)
  const meta: ListenMeta = {
    eventId: liste.eventId, erstelltAt: liste.erstelltAt, event: liste.event, baender: liste.baender, stand: liste.stand,
  }
  tx.objectStore('meta').put(meta)
  await abgeschlossen(tx)
}

export async function speichereMeta(meta: ListenMeta): Promise<void> {
  const d = await db()
  const tx = d.transaction('meta', 'readwrite')
  tx.objectStore('meta').put(meta)
  await abgeschlossen(tx)
}

export async function speichereTicket(eventId: string, t: EinlassOfflineTicket): Promise<void> {
  const d = await db()
  const tx = d.transaction('tickets', 'readwrite')
  tx.objectStore('tickets').put({ ...t, k: `${eventId}|${t.h}`, eventId } satisfies GespeichertesTicket)
  await abgeschlossen(tx)
}

export async function reiheEin(scan: WartenderScan): Promise<void> {
  const d = await db()
  const tx = d.transaction('warteschlange', 'readwrite')
  tx.objectStore('warteschlange').put(scan)
  await abgeschlossen(tx)
}

export async function warteschlange(eventId?: string): Promise<WartenderScan[]> {
  const d = await db()
  const store = d.transaction('warteschlange', 'readonly').objectStore('warteschlange')
  const alle = await ergebnis((eventId ? store.index('event').getAll(bereich(eventId)) : store.getAll()) as IDBRequest<WartenderScan[]>)
  return alle.sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt))
}

export async function entferneAusWarteschlange(scanIds: string[]): Promise<void> {
  if (scanIds.length === 0) return
  const d = await db()
  const tx = d.transaction('warteschlange', 'readwrite')
  for (const id of scanIds) tx.objectStore('warteschlange').delete(id)
  await abgeschlossen(tx)
}

/**
 * Datensparsamkeit: Listen von Events löschen, die nicht mehr zur Auswahl
 * stehen (vorbei, abgesagt) — außer es warten dort noch Scans aufs Nachreichen.
 */
export async function raeumeAuf(aktuelleEvents: Set<string>): Promise<void> {
  const d = await db()
  const offen = new Set((await warteschlange()).map(s => s.eventId))
  const metas = await ergebnis(d.transaction('meta', 'readonly').objectStore('meta').getAllKeys())
  for (const eventId of metas as string[]) {
    if (!aktuelleEvents.has(eventId) && !offen.has(eventId)) await loescheListe(eventId)
  }
}

export async function loescheListe(eventId: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['meta', 'tickets'], 'readwrite')
  const keys = await ergebnis(tx.objectStore('tickets').index('event').getAllKeys(bereich(eventId)))
  for (const k of keys) tx.objectStore('tickets').delete(k)
  tx.objectStore('meta').delete(eventId)
  await abgeschlossen(tx)
}

/** Gerät abmelden: alles weg (vorher prüft die App, ob noch Scans warten). */
export async function loescheAlles(): Promise<void> {
  const d = await db()
  const tx = d.transaction(['meta', 'tickets', 'warteschlange'], 'readwrite')
  tx.objectStore('meta').clear()
  tx.objectStore('tickets').clear()
  tx.objectStore('warteschlange').clear()
  await abgeschlossen(tx)
}
