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
    id:         row.id,
    mandantId:  row.mandantId,
    name:       row.name,
    ip:         row.ip,
    port:       row.port,
    istBackup:  row.istBackup,
    fallbackId: row.fallbackId ?? null,
    aktiv:      row.aktiv,
    createdAt:  row.createdAt.toISOString(),
    updatedAt:  row.updatedAt.toISOString(),
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
  if (update.istBackup  !== undefined) values.istBackup  = update.istBackup
  if (update.fallbackId !== undefined) values.fallbackId = update.fallbackId ?? null
  if (update.aktiv      !== undefined) values.aktiv      = update.aktiv

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

/** Baut den ESC/POS-Buffer für einen Bonierbon zusammen. */
function baueBonierbon(tischNummer: string, kellner: string, zeilen: BonierdruckZeile[]): Buffer {
  const ESC = 0x1b
  const GS  = 0x1d
  const parts: Buffer[] = []
  const add = (data: number[] | Buffer | string) => {
    if (typeof data === 'string') parts.push(Buffer.from(data, 'utf8'))
    else parts.push(Buffer.from(data))
  }

  add([ESC, 0x40])
  add([ESC, 0x61, 0x01])
  add([ESC, 0x21, 0x10])
  add(`Tisch ${tischNummer}\n`)
  add([ESC, 0x21, 0x00])
  add(`${kellner}  ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}\n`)
  add('--------------------------------\n')
  add([ESC, 0x61, 0x00])
  for (const z of zeilen) {
    const links  = `${z.menge}x ${z.bezeichnung}`
    const rechts = z.preisLabel
    const leer   = Math.max(1, 32 - links.length - rechts.length)
    add(`${links}${' '.repeat(leer)}${rechts}\n`)
  }
  add('--------------------------------\n')
  add([GS, 0x56, 0x42, 0x00])
  return Buffer.concat(parts)
}

function sendTcp(ip: string, port: number, bon: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    socket.setTimeout(5000)
    socket.connect(port, ip, () => {
      socket.write(bon, () => { socket.destroy(); resolve() })
    })
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')) })
    socket.on('error', (err) => reject(err))
  })
}

/**
 * Druckt einen Bonierbon an einen konkreten Drucker.
 * Bei Fehler wird automatisch der Fallback-Drucker versucht (wenn konfiguriert).
 */
export async function druckeBonierbon(
  db:          Db,
  druckerId:   string,
  mandantId:   string,
  tischNummer: string,
  kellner:     string,
  zeilen:      BonierdruckZeile[],
): Promise<void> {
  const [drucker] = await db
    .select()
    .from(bonierdrucker)
    .where(and(eq(bonierdrucker.id, druckerId), eq(bonierdrucker.mandantId, mandantId)))
    .limit(1)

  if (!drucker) throw new Error(`Bonierdrucker ${druckerId} nicht gefunden`)

  const bon = baueBonierbon(tischNummer, kellner, zeilen)

  try {
    await sendTcp(drucker.ip, drucker.port, bon)
  } catch (primaryErr) {
    // Fallback versuchen wenn konfiguriert
    if (drucker.fallbackId) {
      const [fallback] = await db
        .select()
        .from(bonierdrucker)
        .where(and(eq(bonierdrucker.id, drucker.fallbackId), eq(bonierdrucker.mandantId, mandantId)))
        .limit(1)

      if (fallback?.aktiv) {
        await sendTcp(fallback.ip, fallback.port, bon)
        return  // Fallback erfolgreich
      }
    }
    throw primaryErr  // Kein Fallback oder Fallback auch gescheitert
  }
}

/**
 * Legacy-Wrapper für Aufrufer die nur IP+Port übergeben (ohne DB-Lookup).
 * Kein Fallback verfügbar.
 */
export function druckeBonierbonDirekt(
  ip:          string,
  port:        number,
  tischNummer: string,
  kellner:     string,
  zeilen:      BonierdruckZeile[],
): Promise<void> {
  return sendTcp(ip, port, baueBonierbon(tischNummer, kellner, zeilen))
}
