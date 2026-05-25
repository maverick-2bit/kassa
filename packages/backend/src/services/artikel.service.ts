/**
 * Artikel-Service: CRUD-Operationen für den Artikelstamm.
 * Soft-Delete via aktiv=false (Artikel werden nie wirklich gelöscht,
 * damit historische Belege weiterhin sinnvoll bleiben).
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { Artikel, ArtikelInput, ArtikelUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel } from '../db/schema.js'

/**
 * Generiert die nächste freie Artikelnummer für einen Mandanten.
 * Format: fortlaufende Ganzzahl, 4-stellig mit führenden Nullen (z.B. "0001").
 * Beachtet auch nicht-numerische artikelnummern (werden ignoriert).
 */
async function generiereArtikelNummer(db: Db, mandantId: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT COALESCE(MAX(
      CASE WHEN artikelnummer ~ '^[0-9]+$' THEN artikelnummer::integer ELSE 0 END
    ), 0) + 1 AS naechste
    FROM artikel
    WHERE mandant_id = ${mandantId}
  `)
  const naechste = Number((result[0] as { naechste: unknown })?.naechste ?? 1)
  return String(naechste).padStart(4, '0')
}

function toDto(row: typeof artikel.$inferSelect): Artikel {
  return {
    id:                   row.id,
    mandantId:            row.mandantId,
    bezeichnung:          row.bezeichnung,
    preisBruttoCent:      row.preisBruttoCent,
    mwstSatz:             row.mwstSatz as Artikel['mwstSatz'],
    artikelnummer:        row.artikelnummer,
    station:              row.station as Artikel['station'],
    kategorieId:          row.kategorieId,
    aktiv:                row.aktiv,
    lagerstandAktiv:      row.lagerstandAktiv,
    lagerstandMenge:      row.lagerstandMenge,
    mindestbestand:       row.mindestbestand,
    istFavorit:           row.istFavorit,
    reihenfolge:          row.reihenfolge,
    favoritenReihenfolge: row.favoritenReihenfolge,
    bonierdruckerId:      row.bonierdruckerId,
    ...(row.bild != null  && { bild: row.bild }),
    createdAt:            row.createdAt.toISOString(),
    updatedAt:            row.updatedAt.toISOString(),
  }
}

export async function erstelleArtikel(db: Db, input: ArtikelInput): Promise<Artikel> {
  const artikelnummer = await generiereArtikelNummer(db, input.mandantId)
  const [created] = await db.insert(artikel).values({
    mandantId:       input.mandantId,
    bezeichnung:     input.bezeichnung,
    preisBruttoCent: input.preisBruttoCent,
    mwstSatz:        input.mwstSatz,
    artikelnummer,
    station:         input.station ?? null,
    kategorieId:     input.kategorieId ?? null,
    lagerstandAktiv: input.lagerstandAktiv ?? false,
    lagerstandMenge: input.lagerstandAktiv ? (input.lagerstandMenge ?? null) : null,
    istFavorit:      input.istFavorit ?? false,
    bonierdruckerId: input.bonierdruckerId ?? null,
    ...(input.bild != null && { bild: input.bild }),
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
  // artikelnummer ist schreibgeschützt (immer auto-generiert)
  if (update.station         !== undefined) values.station         = update.station
  if (update.kategorieId     !== undefined) values.kategorieId     = update.kategorieId
  if (update.aktiv           !== undefined) values.aktiv           = update.aktiv
  if (update.lagerstandAktiv      !== undefined) values.lagerstandAktiv      = update.lagerstandAktiv
  if (update.lagerstandMenge      !== undefined) values.lagerstandMenge      = update.lagerstandMenge
  if (update.mindestbestand       !== undefined) values.mindestbestand       = update.mindestbestand
  if (update.istFavorit           !== undefined) values.istFavorit           = update.istFavorit
  if (update.reihenfolge          !== undefined) values.reihenfolge          = update.reihenfolge
  if (update.favoritenReihenfolge !== undefined) values.favoritenReihenfolge = update.favoritenReihenfolge
  if (update.bonierdruckerId      !== undefined) values.bonierdruckerId      = update.bonierdruckerId
  if (update.bild                 !== undefined) values.bild                 = update.bild ?? null

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
