/**
 * Artikel-Service: CRUD-Operationen für den Artikelstamm.
 * Soft-Delete via aktiv=false (Artikel werden nie wirklich gelöscht,
 * damit historische Belege weiterhin sinnvoll bleiben).
 */

import { and, asc, eq } from 'drizzle-orm'
import type { Artikel, ArtikelInput, ArtikelUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel } from '../db/schema.js'

function toDto(row: typeof artikel.$inferSelect): Artikel {
  return {
    id:              row.id,
    mandantId:       row.mandantId,
    bezeichnung:     row.bezeichnung,
    preisBruttoCent: row.preisBruttoCent,
    mwstSatz:        row.mwstSatz as Artikel['mwstSatz'],
    artikelnummer:   row.artikelnummer,
    station:         row.station as Artikel['station'],
    kategorieId:     row.kategorieId,
    aktiv:           row.aktiv,
    createdAt:       row.createdAt.toISOString(),
    updatedAt:       row.updatedAt.toISOString(),
  }
}

export async function erstelleArtikel(db: Db, input: ArtikelInput): Promise<Artikel> {
  const [created] = await db.insert(artikel).values({
    mandantId:       input.mandantId,
    bezeichnung:     input.bezeichnung,
    preisBruttoCent: input.preisBruttoCent,
    mwstSatz:        input.mwstSatz,
    artikelnummer:   input.artikelnummer ?? null,
    station:         input.station ?? null,
    kategorieId:     input.kategorieId ?? null,
  }).returning()
  if (!created) throw new Error('Artikel konnte nicht angelegt werden')
  return toDto(created)
}

export async function listeArtikel(
  db: Db,
  mandantId: string,
  opts: { nurAktive?: boolean } = {},
): Promise<Artikel[]> {
  const conditions = opts.nurAktive
    ? and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true))
    : eq(artikel.mandantId, mandantId)

  const rows = await db
    .select()
    .from(artikel)
    .where(conditions)
    .orderBy(asc(artikel.bezeichnung))

  return rows.map(toDto)
}

export async function aktualisiereArtikel(
  db: Db,
  id: string,
  update: ArtikelUpdate,
): Promise<Artikel | null> {
  const values: Partial<typeof artikel.$inferInsert> = { updatedAt: new Date() }
  if (update.bezeichnung     !== undefined) values.bezeichnung     = update.bezeichnung
  if (update.preisBruttoCent !== undefined) values.preisBruttoCent = update.preisBruttoCent
  if (update.mwstSatz        !== undefined) values.mwstSatz        = update.mwstSatz
  if (update.artikelnummer   !== undefined) values.artikelnummer   = update.artikelnummer
  if (update.station         !== undefined) values.station         = update.station
  if (update.kategorieId     !== undefined) values.kategorieId     = update.kategorieId
  if (update.aktiv           !== undefined) values.aktiv           = update.aktiv

  const [updated] = await db
    .update(artikel)
    .set(values)
    .where(eq(artikel.id, id))
    .returning()

  return updated ? toDto(updated) : null
}

export async function deaktiviereArtikel(db: Db, id: string): Promise<Artikel | null> {
  return aktualisiereArtikel(db, id, { aktiv: false })
}
