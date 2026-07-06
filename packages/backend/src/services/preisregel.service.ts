/**
 * Preisregel-Service (Happy Hour / zeitgesteuerte Preise) — mandant-scoped CRUD.
 * Die eigentliche Preisanwendung passiert im Frontend beim Kassieren/Bonieren
 * (happyHourPreisCent aus @kassa/shared); hier werden nur die Regeln verwaltet.
 */

import { eq } from 'drizzle-orm'
import type { Preisregel, PreisregelInput, PreisregelUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { preisregeln } from '../db/schema.js'

function toResponse(row: typeof preisregeln.$inferSelect): Preisregel {
  return {
    id:            row.id,
    name:          row.name,
    aktiv:         row.aktiv,
    wochentage:    (row.wochentage as number[]) ?? [],
    vonZeit:       row.vonZeit,
    bisZeit:       row.bisZeit,
    rabattProzent: row.rabattProzent,
    kategorieIds:  (row.kategorieIds as string[]) ?? [],
    artikelIds:    (row.artikelIds as string[]) ?? [],
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  }
}

export async function listePreisregeln(db: Db, mandantId: string): Promise<Preisregel[]> {
  const rows = await db
    .select()
    .from(preisregeln)
    .where(eq(preisregeln.mandantId, mandantId))
    .orderBy(preisregeln.createdAt)
  return rows.map(toResponse)
}

export async function erstellePreisregel(db: Db, mandantId: string, input: PreisregelInput): Promise<Preisregel> {
  const [row] = await db
    .insert(preisregeln)
    .values({
      mandantId,
      name:          input.name,
      aktiv:         input.aktiv,
      wochentage:    input.wochentage,
      vonZeit:       input.vonZeit,
      bisZeit:       input.bisZeit,
      rabattProzent: input.rabattProzent,
      kategorieIds:  input.kategorieIds,
      artikelIds:    input.artikelIds,
    })
    .returning()
  if (!row) throw new Error('Preisregel konnte nicht angelegt werden')
  return toResponse(row)
}

export async function aktualisierePreisregel(
  db: Db,
  id: string,
  input: PreisregelUpdate,
): Promise<Preisregel | null> {
  const updates: Partial<typeof preisregeln.$inferInsert> = { updatedAt: new Date() }
  if (input.name          !== undefined) updates.name          = input.name
  if (input.aktiv         !== undefined) updates.aktiv         = input.aktiv
  if (input.wochentage    !== undefined) updates.wochentage    = input.wochentage
  if (input.vonZeit       !== undefined) updates.vonZeit       = input.vonZeit
  if (input.bisZeit       !== undefined) updates.bisZeit       = input.bisZeit
  if (input.rabattProzent !== undefined) updates.rabattProzent = input.rabattProzent
  if (input.kategorieIds  !== undefined) updates.kategorieIds  = input.kategorieIds
  if (input.artikelIds    !== undefined) updates.artikelIds    = input.artikelIds

  const [row] = await db.update(preisregeln).set(updates).where(eq(preisregeln.id, id)).returning()
  return row ? toResponse(row) : null
}

export async function loeschePreisregel(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .delete(preisregeln)
    .where(eq(preisregeln.id, id))
    .returning({ id: preisregeln.id })
  return !!row
}
