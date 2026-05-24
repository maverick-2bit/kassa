/**
 * Bonierdrucker-Service: CRUD für ESC/POS-Bonierdrucker (mandantenweit).
 * Testdruck-Funktion sendet einen einfachen ESC/POS-Bon an IP:Port.
 */

import { and, asc, eq } from 'drizzle-orm'
import net from 'net'
import type { Bonierdrucker, BonierdruckerInput, BonierdruckerUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { bonierdrucker } from '../db/schema.js'

function toDto(row: typeof bonierdrucker.$inferSelect): Bonierdrucker {
  return {
    id:        row.id,
    mandantId: row.mandantId,
    name:      row.name,
    ip:        row.ip,
    port:      row.port,
    istBackup: row.istBackup,
    aktiv:     row.aktiv,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listeBonierdrucker(db: Db, mandantId: string): Promise<Bonierdrucker[]> {
  const rows = await db
    .select()
    .from(bonierdrucker)
    .where(eq(bonierdrucker.mandantId, mandantId))
    .orderBy(asc(bonierdrucker.name))
  return rows.map(toDto)
}

export async function erstelleBonierdrucker(
  db: Db,
  mandantId: string,
  input: BonierdruckerInput,
): Promise<Bonierdrucker> {
  const [created] = await db.insert(bonierdrucker).values({
    mandantId,
    name:      input.name,
    ip:        input.ip,
    port:      input.port ?? 9100,
    istBackup: input.istBackup ?? false,
  }).returning()
  if (!created) throw new Error('Bonierdrucker konnte nicht angelegt werden')
  return toDto(created)
}

export async function aktualisiereBonierdrucker(
  db: Db,
  id: string,
  mandantId: string,
  update: BonierdruckerUpdate,
): Promise<Bonierdrucker | null> {
  const values: Partial<typeof bonierdrucker.$inferInsert> = { updatedAt: new Date() }
  if (update.name      !== undefined) values.name      = update.name
  if (update.ip        !== undefined) values.ip        = update.ip
  if (update.port      !== undefined) values.port      = update.port
  if (update.istBackup !== undefined) values.istBackup = update.istBackup
  if (update.aktiv     !== undefined) values.aktiv     = update.aktiv

  const [updated] = await db
    .update(bonierdrucker)
    .set(values)
    .where(and(eq(bonierdrucker.id, id), eq(bonierdrucker.mandantId, mandantId)))
    .returning()
  return updated ? toDto(updated) : null
}

export async function loescheBonierdrucker(
  db: Db,
  id: string,
  mandantId: string,
): Promise<boolean> {
  const result = await db
    .delete(bonierdrucker)
    .where(and(eq(bonierdrucker.id, id), eq(bonierdrucker.mandantId, mandantId)))
    .returning({ id: bonierdrucker.id })
  return result.length > 0
}

// ---------------------------------------------------------------------------
// Testdruck
// ---------------------------------------------------------------------------

/** Sendet einen minimalen ESC/POS-Testbon an den Drucker. */
export function testdruckBonierdrucker(ip: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timeout = 5000

    const ESC = 0x1b
    const GS  = 0x1d

    const bon = Buffer.from([
      // ESC @ — Reset
      ESC, 0x40,
      // ESC ! 0x38 — fett + doppelt
      ESC, 0x21, 0x38,
      ...Buffer.from('  TESTDRUCK\n', 'utf8'),
      ESC, 0x21, 0x00,
      ...Buffer.from('Bonierdrucker ist erreichbar.\n\n', 'utf8'),
      // Feed + Cut
      GS, 0x56, 0x42, 0x00,
    ])

    socket.setTimeout(timeout)
    socket.connect(port, ip, () => {
      socket.write(bon, () => {
        socket.destroy()
        resolve()
      })
    })
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')) })
    socket.on('error', (err) => reject(err))
  })
}

// ---------------------------------------------------------------------------
// Drucken eines Bonierbons
// ---------------------------------------------------------------------------

export interface BonierdruckZeile {
  bezeichnung: string
  menge:       number
  preisLabel:  string
}

/** Druckt einen Bonierbon an einen konkreten Drucker (IP:Port). */
export function druckeBonierbon(
  ip: string,
  port: number,
  tischNummer: string,
  kellner: string,
  zeilen: BonierdruckZeile[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const ESC = 0x1b
    const GS  = 0x1d

    // Bon zusammenbauen
    const parts: Buffer[] = []
    const add = (data: number[] | Buffer | string) => {
      if (typeof data === 'string') parts.push(Buffer.from(data, 'utf8'))
      else parts.push(Buffer.from(data))
    }

    add([ESC, 0x40])                          // Reset
    add([ESC, 0x61, 0x01])                    // Zentriert
    add([ESC, 0x21, 0x10])                    // Doppelte Höhe
    add(`Tisch ${tischNummer}\n`)
    add([ESC, 0x21, 0x00])                    // Normal
    add(`${kellner}  ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}\n`)
    add('--------------------------------\n')
    add([ESC, 0x61, 0x00])                    // Links

    for (const z of zeilen) {
      const links  = `${z.menge}x ${z.bezeichnung}`
      const rechts = z.preisLabel
      const leer   = Math.max(1, 32 - links.length - rechts.length)
      add(`${links}${' '.repeat(leer)}${rechts}\n`)
    }

    add('--------------------------------\n')
    add([GS, 0x56, 0x42, 0x00])              // Cut

    const bon = Buffer.concat(parts)
    socket.setTimeout(5000)
    socket.connect(port, ip, () => {
      socket.write(bon, () => { socket.destroy(); resolve() })
    })
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')) })
    socket.on('error', (err) => reject(err))
  })
}
