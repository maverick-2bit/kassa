/**
 * Drucker-Keep-Alive: pingt alle aktiven ESC/POS-Drucker (Kassen-Belegdrucker
 * + Bonierdrucker-Bibliothek) in konfigurierbarem Intervall per TCP an, damit
 * sie nicht in den Energiespar-/Schlafmodus wechseln.
 *
 * Methode: DLE EOT 1 (0x10 0x04 0x01) — die Echtzeit-Statusabfrage druckt
 * nichts, weckt die Netzwerk-Schnittstelle und liefert als Nebenprodukt den
 * Online-Status (Antwort-Byte). Drucker, die DLE EOT nicht beantworten,
 * gelten mit erfolgreichem TCP-Connect als erreichbar.
 *
 * Der letzte Status je Drucker liegt in einem In-Memory-Cache und wird über
 * das Admin-Monitoring (Einstellungen → System) angezeigt.
 */

import { Socket } from 'node:net'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { bonierdrucker, drucker, mandanten } from '../db/schema.js'

export interface DruckerPingStatus {
  quelle:      'beleg' | 'bonier'
  name:        string
  ip:          string
  port:        number
  ok:          boolean
  /** true, wenn der Drucker das DLE-EOT-Status-Byte beantwortet hat */
  statusByte:  boolean
  dauerMs:     number
  fehler:      string | null
  geprueftAm:  string   // ISO
}

const DLE_EOT_1 = Buffer.from([0x10, 0x04, 0x01])

/** Letzter bekannter Status je Mandant (Key `${ip}:${port}`) */
const statusCache = new Map<string, Map<string, DruckerPingStatus>>()

/** Letzter Lauf-Zeitpunkt je Mandant (für die Intervall-Steuerung des Crons) */
const letzterLauf = new Map<string, number>()

export function holeDruckerKeepAliveStatus(mandantId: string): DruckerPingStatus[] {
  return [...(statusCache.get(mandantId)?.values() ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Ein einzelner Keep-Alive-Ping: TCP-Connect → DLE EOT 1 → auf Status-Byte
 * warten (bis timeoutMs). Erfolgreicher Connect ohne Antwort zählt als ok.
 */
export function pingeDrucker(ip: string, port: number, timeoutMs = 2500): Promise<Omit<DruckerPingStatus, 'quelle' | 'name' | 'ip' | 'port'>> {
  const start = Date.now()
  return new Promise((resolve) => {
    const socket = new Socket()
    let verbunden = false
    let beantwortet = false
    let abgeschlossen = false

    const fertig = (ok: boolean, fehler: string | null) => {
      if (abgeschlossen) return
      abgeschlossen = true
      socket.destroy()
      resolve({
        ok,
        statusByte: beantwortet,
        dauerMs:    Date.now() - start,
        fehler,
        geprueftAm: new Date().toISOString(),
      })
    }

    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => fertig(verbunden, verbunden ? null : 'Timeout beim Verbinden'))
    socket.once('error', (err) => fertig(false, err.message))
    socket.once('data', () => { beantwortet = true; fertig(true, null) })
    socket.connect(port, ip, () => {
      verbunden = true
      socket.write(DLE_EOT_1)
      // Antwortfenster: viele Drucker antworten in <100 ms; wer nicht
      // antwortet, wird nach kurzem Fenster als „connect-ok" gewertet.
      setTimeout(() => fertig(true, null), Math.min(800, timeoutMs))
    })
  })
}

/**
 * Führt für alle Mandanten mit aktivem Keep-Alive (Intervall > 0) einen
 * Ping-Durchlauf aus, sofern das Intervall seit dem letzten Lauf verstrichen
 * ist. Mit festem `jetztMs` deterministisch testbar.
 */
export async function fuehreKeepAliveDurch(
  db:      Db,
  jetztMs: number = Date.now(),
  opts:    { nurMandantId?: string; force?: boolean } = {},
): Promise<Map<string, DruckerPingStatus[]>> {
  const zeilen = await db
    .select({ id: mandanten.id, intervall: mandanten.druckerKeepAliveSekunden })
    .from(mandanten)
    .where(
      opts.nurMandantId
        ? and(eq(mandanten.status, 'aktiv'), eq(mandanten.id, opts.nurMandantId))
        : eq(mandanten.status, 'aktiv'),
    )

  const ergebnis = new Map<string, DruckerPingStatus[]>()

  for (const m of zeilen) {
    if (m.intervall <= 0 && !opts.force) { statusCache.delete(m.id); letzterLauf.delete(m.id); continue }
    if (!opts.force) {
      const letzter = letzterLauf.get(m.id) ?? 0
      if (jetztMs - letzter < m.intervall * 1000) continue
    }
    letzterLauf.set(m.id, jetztMs)

    const [belegDrucker, bonierDrucker] = await Promise.all([
      db.select().from(drucker).where(and(eq(drucker.mandantId, m.id), eq(drucker.aktiv, true))),
      db.select().from(bonierdrucker).where(and(eq(bonierdrucker.mandantId, m.id), eq(bonierdrucker.aktiv, true))),
    ])

    const ziele: Array<{ quelle: 'beleg' | 'bonier'; name: string; ip: string; port: number }> = [
      ...belegDrucker.map(d => ({ quelle: 'beleg' as const,  name: d.name, ip: d.ip, port: d.port })),
      ...bonierDrucker.map(d => ({ quelle: 'bonier' as const, name: d.name, ip: d.ip, port: d.port })),
    ]

    // Duplikate (gleicher Drucker als Beleg- UND Bonierziel) nur einmal pingen
    const gesehen = new Set<string>()
    const eindeutig = ziele.filter(z => {
      const key = `${z.ip}:${z.port}`
      if (gesehen.has(key)) return false
      gesehen.add(key)
      return true
    })

    const stati = await Promise.all(eindeutig.map(async (z) => {
      const ping = await pingeDrucker(z.ip, z.port)
      return { ...z, ...ping }
    }))

    const cache = new Map<string, DruckerPingStatus>()
    for (const s of stati) cache.set(`${s.ip}:${s.port}`, s)
    statusCache.set(m.id, cache)
    ergebnis.set(m.id, stati)
  }

  return ergebnis
}

/** Nur für Tests: Cache + Laufzeit-Stempel zurücksetzen. */
export function _resetKeepAliveState(): void {
  statusCache.clear()
  letzterLauf.clear()
}
