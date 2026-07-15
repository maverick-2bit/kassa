/**
 * Bondrucker-Bibliothek (mandantenweiter Pool) — CRUD + Testdruck + Auswahl je Kasse.
 *
 * Die Kasse referenziert per kassen.druckerId ihren Bondrucker; die kassen.drucker*-
 * Inline-Felder sind der aufgelöste SNAPSHOT (der Druckpfad in drucker.service liest
 * weiterhin nur diese). Auswahl und Bearbeiten frischen den Snapshot auf, Löschen löst
 * betroffene Kassen ab. So bleibt der Druckpfad unverändert.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { DruckerPool, DruckerPoolInput, DruckerPoolUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { drucker, kassen } from '../db/schema.js'
import { sendBytes } from './drucker.service.js'

function toDto(row: typeof drucker.$inferSelect): DruckerPool {
  return {
    id:         row.id,
    mandantId:  row.mandantId,
    name:       row.name,
    ip:         row.ip,
    port:       row.port,
    breite:     row.breiteZeichen,
    timeoutSek: row.timeoutSek,
    aktiv:      row.aktiv,
    createdAt:  row.createdAt.toISOString(),
    updatedAt:  row.updatedAt.toISOString(),
  }
}

/** Inline-Snapshot einer Kasse aus einer Pool-Zeile (oder „kein Drucker"). */
function snapshotVon(row: typeof drucker.$inferSelect | null) {
  if (!row) {
    return { druckerId: null, druckerIp: null, druckerAktiv: false, updatedAt: new Date() }
  }
  return {
    druckerId:         row.id,
    druckerIp:         row.ip,
    druckerPort:       row.port,
    druckerBreite:     row.breiteZeichen,
    druckerTimeoutSek: row.timeoutSek,
    druckerAktiv:      row.aktiv,
    updatedAt:         new Date(),
  }
}

export async function listeDrucker(db: Db, mandantId: string): Promise<DruckerPool[]> {
  const rows = await db
    .select()
    .from(drucker)
    .where(eq(drucker.mandantId, mandantId))
    .orderBy(asc(drucker.name))
  return rows.map(toDto)
}

export async function erstelleDrucker(
  db: Db,
  mandantId: string,
  input: DruckerPoolInput,
): Promise<DruckerPool> {
  const [created] = await db.insert(drucker).values({
    mandantId,
    name:          input.name,
    ip:            input.ip,
    port:          input.port ?? 9100,
    breiteZeichen: input.breite ?? 42,
    timeoutSek:    input.timeoutSek ?? 5,
    aktiv:         input.aktiv ?? true,
  }).returning()
  if (!created) throw new Error('Drucker konnte nicht angelegt werden')
  return toDto(created)
}

export async function aktualisiereDrucker(
  db: Db,
  id: string,
  mandantId: string,
  update: DruckerPoolUpdate,
): Promise<DruckerPool | null> {
  const values: Partial<typeof drucker.$inferInsert> = { updatedAt: new Date() }
  if (update.name       !== undefined) values.name          = update.name
  if (update.ip         !== undefined) values.ip            = update.ip
  if (update.port       !== undefined) values.port          = update.port
  if (update.breite     !== undefined) values.breiteZeichen = update.breite
  if (update.timeoutSek !== undefined) values.timeoutSek    = update.timeoutSek
  if (update.aktiv      !== undefined) values.aktiv         = update.aktiv

  const [updated] = await db
    .update(drucker)
    .set(values)
    .where(and(eq(drucker.id, id), eq(drucker.mandantId, mandantId)))
    .returning()
  if (!updated) return null

  // Snapshot aller Kassen auffrischen, die diesen Drucker gewählt haben.
  await db.update(kassen).set(snapshotVon(updated)).where(eq(kassen.druckerId, updated.id))
  return toDto(updated)
}

export async function loescheDrucker(db: Db, id: string, mandantId: string): Promise<boolean> {
  // Betroffene Kassen zuerst ablösen (druckerId=null, Druck deaktiviert),
  // damit der Druckpfad danach sauber „kein Drucker" ergibt.
  await db.update(kassen).set(snapshotVon(null)).where(eq(kassen.druckerId, id))
  const result = await db
    .delete(drucker)
    .where(and(eq(drucker.id, id), eq(drucker.mandantId, mandantId)))
    .returning({ id: drucker.id })
  return result.length > 0
}

/** Setzt den Bondrucker einer Kasse (aus dem Pool) und schreibt den Snapshot. */
export async function waehleDruckerFuerKasse(
  db: Db,
  kasseId: string,
  mandantId: string,
  druckerId: string | null,
): Promise<boolean> {
  let row: typeof drucker.$inferSelect | null = null
  if (druckerId) {
    const [d] = await db
      .select()
      .from(drucker)
      .where(and(eq(drucker.id, druckerId), eq(drucker.mandantId, mandantId)))
      .limit(1)
    if (!d) return false
    row = d
  }
  const [updated] = await db
    .update(kassen)
    .set(snapshotVon(row))
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .returning({ id: kassen.id })
  return !!updated
}

// ---------------------------------------------------------------------------
// Testdruck (minimaler ESC/POS-Bon direkt an IP:Port)
// ---------------------------------------------------------------------------

export async function testdruckDrucker(ip: string, port: number, timeoutSek = 5): Promise<void> {
  const ESC = 0x1b
  const GS  = 0x1d
  const bon = Buffer.from([
    ESC, 0x40,               // Reset
    ESC, 0x61, 0x01,         // zentriert
    ESC, 0x21, 0x38,         // fett + doppelt
    ...Buffer.from('TESTDRUCK\n', 'utf8'),
    ESC, 0x21, 0x00,
    ...Buffer.from('Bondrucker ist erreichbar.\n\n', 'utf8'),
    GS, 0x56, 0x42, 0x00,    // Feed + Cut
  ])
  // Über den bewährten sendBytes-Pfad: schreiben, flushen, dann sauber schließen
  // (socket.end statt destroy) — sonst verwirft der Drucker die Bytes.
  await sendBytes(bon, { ip, port, breite: 42, timeoutMs: timeoutSek * 1000 })
}
