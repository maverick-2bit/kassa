/**
 * Bonierdrucker-Service: CRUD für ESC/POS-Bonierdrucker (mandantenweit).
 * Testdruck-Funktion sendet einen einfachen ESC/POS-Bon an IP:Port.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { Bonierdrucker, BonierdruckerInput, BonierdruckerUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { bonierdrucker } from '../db/schema.js'
import { sendBytes } from './drucker.service.js'
import * as ep from './escpos/commands.js'

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

/** Sendet einen minimalen ESC/POS-Testbon an den Drucker (über den bewährten
 *  sendBytes-Pfad mit sauberem socket.end statt destroy — sonst verwirft der
 *  Drucker die gerade gesendeten Bytes). */
export async function testdruckBonierdrucker(ip: string, port: number): Promise<void> {
  const ESC = 0x1b
  const bon = Buffer.concat([
    Buffer.from([ESC, 0x40, ESC, 0x61, 0x01, ESC, 0x21, 0x38]),  // Reset, zentriert, fett+doppelt
    Buffer.from('TESTDRUCK\n', 'utf8'),
    Buffer.from([ESC, 0x21, 0x00, ESC, 0x61, 0x00]),             // normal, linksbündig
    Buffer.from('Bonierdrucker ist erreichbar.\n', 'utf8'),
    ep.cut(),                                                     // Vorschub (4 Zeilen) + Schnitt
  ])
  await sendBytes(bon, { ip, port, breite: 42, timeoutMs: 5000 })
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
function baueBonierbon(tischNummer: string, kellner: string, zeilen: BonierdruckZeile[], storno = false): Buffer {
  const ESC = 0x1b
  const parts: Buffer[] = []
  const add = (data: number[] | Buffer | string) => {
    if (typeof data === 'string') parts.push(Buffer.from(data, 'utf8'))
    else parts.push(Buffer.from(data))
  }

  add([ESC, 0x40])
  add([ESC, 0x61, 0x01])
  if (storno) {
    // Unübersehbar: invertiert (weiß auf schwarz) + fett/doppelhoch
    add([0x1d, 0x42, 0x01])           // GS B 1 — invertierte Darstellung
    add([ESC, 0x21, 0x18])
    add('*** STORNO ***\n')
    add([0x1d, 0x42, 0x00])
  }
  // Tischnummer fett + doppelte Höhe (0x08 fett + 0x10 doppelhoch = 0x18) — gut
  // sichtbar in der Küche, welcher Tisch die Bestellung ist.
  add([ESC, 0x21, 0x18])
  add(`Tisch ${tischNummer}\n`)
  add([ESC, 0x21, 0x00])
  add(`${kellner}  ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}\n`)
  add('--------------------------------\n')
  add([ESC, 0x61, 0x00])
  // Artikel groß + fett (fett 0x08 + doppelte Höhe 0x10 = 0x18) für gute Lesbarkeit
  // in der Küche. Preis entfällt (küchenirrelevant) — Fokus auf Menge + Bezeichnung.
  add([ESC, 0x21, 0x18])
  for (const z of zeilen) {
    add(`${z.menge}x ${z.bezeichnung}\n`)
  }
  add([ESC, 0x21, 0x00])
  if (storno) {
    add([ESC, 0x61, 0x01])
    add([ESC, 0x21, 0x08])
    add('NICHT ZUBEREITEN\n')
    add([ESC, 0x21, 0x00])
    add([ESC, 0x61, 0x00])
  }
  add('--------------------------------\n')
  add(ep.cut())   // Vorschub (4 Zeilen) + Schnitt — sonst bleibt der Bon im Gerät stecken
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Erledigt-Bon (Runner-Beleg): druckt beim (Teil-)Erledigen am KDS.
// Bei aktivem KDS schweigt der Bonierdrucker beim Bestellen — die Küche
// arbeitet am Bildschirm; der Papierbon entsteht erst, wenn etwas FERTIG ist,
// und dient dem Runner als Laufzettel.
// ---------------------------------------------------------------------------

export interface ErledigtBonInhalt {
  tischNummer: string
  kellner:     string
  /** Gerade fertig gewordene Positionen — groß gedruckt */
  fertig:      BonierdruckZeile[]
  /** Noch offene Rest-Positionen (klein) — leer = Bestellung komplett */
  rest:        BonierdruckZeile[]
}

function baueErledigtBon(inhalt: ErledigtBonInhalt): Buffer {
  const ESC = 0x1b
  const parts: Buffer[] = []
  const add = (data: number[] | Buffer | string) => {
    if (typeof data === 'string') parts.push(Buffer.from(data, 'utf8'))
    else parts.push(Buffer.from(data))
  }

  const teil = inhalt.rest.length > 0

  add([ESC, 0x40])
  add([ESC, 0x61, 0x01])
  // Kopf unübersehbar: invertiert + fett/doppelhoch
  add([0x1d, 0x42, 0x01])
  add([ESC, 0x21, 0x18])
  add(teil ? 'TEIL DER BESTELLUNG\n' : 'BESTELLUNG KOMPLETT\n')
  add([0x1d, 0x42, 0x00])
  add([ESC, 0x21, 0x18])
  add(`Tisch ${inhalt.tischNummer}\n`)
  add([ESC, 0x21, 0x00])
  add(`${inhalt.kellner}  ${new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}\n`)
  add('--------------------------------\n')
  add([ESC, 0x61, 0x00])
  // Fertige Positionen groß + fett
  add([ESC, 0x21, 0x18])
  for (const z of inhalt.fertig) {
    add(`${z.menge}x ${z.bezeichnung}\n`)
  }
  add([ESC, 0x21, 0x00])
  if (teil) {
    // Der Runner soll dem Gast sagen können, was noch nachkommt
    add('--------------------------------\n')
    add([ESC, 0x21, 0x08])
    add('Es folgt noch:\n')
    add([ESC, 0x21, 0x00])
    for (const z of inhalt.rest) {
      add(`  ${z.menge}x ${z.bezeichnung}\n`)
    }
  }
  add('--------------------------------\n')
  add(ep.cut())
  return Buffer.concat(parts)
}

/**
 * Druckt den Erledigt-Bon an ALLE aktiven Nicht-Backup-Bonierdrucker
 * (Muster kdsBonNachdrucken), je Drucker mit Fallback-Versuch.
 */
export async function druckeErledigtBon(
  db:        Db,
  mandantId: string,
  inhalt:    ErledigtBonInhalt,
): Promise<{ gedruckt: number; fehler: number }> {
  const drucker = await db
    .select()
    .from(bonierdrucker)
    .where(and(
      eq(bonierdrucker.mandantId, mandantId),
      eq(bonierdrucker.aktiv, true),
      eq(bonierdrucker.istBackup, false),
    ))

  const bon = baueErledigtBon(inhalt)
  let gedruckt = 0
  let fehler   = 0
  for (const d of drucker) {
    try {
      try {
        await sendTcp(d.ip, d.port, bon)
      } catch (primaerFehler) {
        if (!d.fallbackId) throw primaerFehler
        const [fallback] = await db
          .select()
          .from(bonierdrucker)
          .where(and(eq(bonierdrucker.id, d.fallbackId), eq(bonierdrucker.mandantId, mandantId)))
          .limit(1)
        if (!fallback?.aktiv) throw primaerFehler
        await sendTcp(fallback.ip, fallback.port, bon)
      }
      gedruckt++
    } catch {
      fehler++
    }
  }
  return { gedruckt, fehler }
}

function sendTcp(ip: string, port: number, bon: Buffer): Promise<void> {
  // sendBytes schließt die Verbindung sauber (flush + socket.end); ein abruptes
  // socket.destroy() direkt nach dem Schreiben verwirft die Bytes am Drucker.
  return sendBytes(bon, { ip, port, breite: 42, timeoutMs: 5000 })
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
  storno = false,
): Promise<void> {
  return sendTcp(ip, port, baueBonierbon(tischNummer, kellner, zeilen, storno))
}
