/**
 * Kategorie-Service: CRUD für Artikel-Kategorien.
 * Soft-Delete via aktiv=false — Kategorien werden nie gelöscht,
 * bestehende Artikel behalten die Referenz.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { Kategorie, KategorieInput, KategorieUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kategorien } from '../db/schema.js'

function toDto(row: typeof kategorien.$inferSelect): Kategorie {
  return {
    id:              row.id,
    mandantId:       row.mandantId,
    name:            row.name,
    farbe:           row.farbe as Kategorie['farbe'],
    reihenfolge:     row.reihenfolge,
    aktiv:           row.aktiv,
    bonierdruckerId: row.bonierdruckerId,
    createdAt:       row.createdAt.toISOString(),
    updatedAt:       row.updatedAt.toISOString(),
  }
}

export async function erstelleKategorie(
  db: Db,
  mandantId: string,
  input: KategorieInput,
): Promise<Kategorie> {
  const [created] = await db.insert(kategorien).values({
    mandantId,
    name:            input.name,
    farbe:           input.farbe,
    reihenfolge:     input.reihenfolge,
    bonierdruckerId: input.bonierdruckerId ?? null,
  }).returning()
  if (!created) throw new Error('Kategorie konnte nicht angelegt werden')
  return toDto(created)
}

export async function listeKategorien(
  db: Db,
  mandantId: string,
  opts: { nurAktive?: boolean } = {},
): Promise<Kategorie[]> {
  const conditions = opts.nurAktive
    ? and(eq(kategorien.mandantId, mandantId), eq(kategorien.aktiv, true))
    : eq(kategorien.mandantId, mandantId)

  const rows = await db
    .select()
    .from(kategorien)
    .where(conditions)
    .orderBy(asc(kategorien.reihenfolge), asc(kategorien.name))

  return rows.map(toDto)
}

export async function aktualisiereKategorie(
  db: Db,
  id: string,
  update: KategorieUpdate,
): Promise<Kategorie | null> {
  const values: Partial<typeof kategorien.$inferInsert> = { updatedAt: new Date() }
  if (update.name            !== undefined) values.name            = update.name
  if (update.farbe           !== undefined) values.farbe           = update.farbe
  if (update.reihenfolge     !== undefined) values.reihenfolge     = update.reihenfolge
  if (update.aktiv           !== undefined) values.aktiv           = update.aktiv
  if (update.bonierdruckerId !== undefined) values.bonierdruckerId = update.bonierdruckerId

  const [updated] = await db
    .update(kategorien)
    .set(values)
    .where(eq(kategorien.id, id))
    .returning()

  return updated ? toDto(updated) : null
}

export async function deaktiviereKategorie(db: Db, id: string): Promise<Kategorie | null> {
  return aktualisiereKategorie(db, id, { aktiv: false })
}
