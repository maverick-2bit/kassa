/**
 * Artikel-Service: CRUD-Operationen für den Artikelstamm.
 * Soft-Delete via aktiv=false (Artikel werden nie wirklich gelöscht,
 * damit historische Belege weiterhin sinnvoll bleiben).
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Artikel, ArtikelInput, ArtikelUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel } from '../db/schema.js'
import {
  berechneVerfuegbareMenge,
  ladeRezepteAngereichert,
  schreibeRezept,
  type BestandteilAngereichert,
  type DbOrTx,
} from './bestandteil.service.js'

/**
 * Generiert die nächste freie Artikelnummer für einen Mandanten.
 * Format: fortlaufende Ganzzahl, 4-stellig mit führenden Nullen (z.B. "0001").
 * Beachtet auch nicht-numerische artikelnummern (werden ignoriert).
 */
async function generiereArtikelNummer(db: DbOrTx, mandantId: string): Promise<string> {
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

function toDto(
  row: typeof artikel.$inferSelect,
  bestandteile: BestandteilAngereichert[] = [],
): Artikel {
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
    seriennummernAktiv:   row.seriennummernAktiv,
    istFavorit:           row.istFavorit,
    reihenfolge:          row.reihenfolge,
    favoritenReihenfolge: row.favoritenReihenfolge,
    bonierdruckerId:      row.bonierdruckerId,
    bonierBeiDirektverkauf: row.bonierBeiDirektverkauf,
    istBestandteil:       row.istBestandteil,
    bestandteile:         bestandteile.map(b => ({
      bestandteilArtikelId: b.bestandteilArtikelId,
      bezeichnung:          b.bezeichnung,
      menge:                b.menge,
    })),
    verfuegbareMenge:     berechneVerfuegbareMenge(bestandteile),
    lieferantId:          row.lieferantId,
    terminalSichtbar:     row.terminalSichtbar,
    ...(row.bild != null  && { bild: row.bild }),
    createdAt:            row.createdAt.toISOString(),
    updatedAt:            row.updatedAt.toISOString(),
  }
}

/** Lädt einen einzelnen Artikel als DTO inkl. Rezept + abgeleiteter Verfügbarkeit. */
async function ladeArtikelDto(db: Db, row: typeof artikel.$inferSelect): Promise<Artikel> {
  const rezepte = await ladeRezepteAngereichert(db, [row.id])
  return toDto(row, rezepte.get(row.id) ?? [])
}

export async function erstelleArtikel(db: Db, input: ArtikelInput): Promise<Artikel> {
  // Artikelnummer außerhalb der Tx generieren (unverändertes Verhalten).
  const artikelnummer = await generiereArtikelNummer(db, input.mandantId)
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(artikel).values({
      mandantId:       input.mandantId,
      bezeichnung:     input.bezeichnung,
      preisBruttoCent: input.preisBruttoCent,
      mwstSatz:        input.mwstSatz,
      artikelnummer,
      station:         input.station ?? null,
      kategorieId:     input.kategorieId ?? null,
      lagerstandAktiv: input.lagerstandAktiv ?? false,
      lagerstandMenge: input.lagerstandAktiv ? (input.lagerstandMenge ?? null) : null,
      seriennummernAktiv: input.seriennummernAktiv ?? false,
      istFavorit:      input.istFavorit ?? false,
      bonierdruckerId: input.bonierdruckerId ?? null,
      bonierBeiDirektverkauf: input.bonierBeiDirektverkauf ?? false,
      istBestandteil:  input.istBestandteil ?? false,
      terminalSichtbar: input.terminalSichtbar ?? null,
      ...(input.bild != null && { bild: input.bild }),
    }).returning()
    if (!row) throw new Error('Artikel konnte nicht angelegt werden')
    if (input.bestandteile.length > 0) {
      await schreibeRezept(tx, row.id, input.mandantId, input.bestandteile)
    }
    return row
  })
  return ladeArtikelDto(db, created)
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

  // Rezepte gebündelt nachladen (ein Join) → verfuegbareMenge + bestandteile je Artikel.
  const rezepte = await ladeRezepteAngereichert(db, rows.map(r => r.id))
  return rows.map(r => toDto(r, rezepte.get(r.id) ?? []))
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
  if (update.seriennummernAktiv   !== undefined) values.seriennummernAktiv   = update.seriennummernAktiv
  if (update.lagerstandMenge      !== undefined) values.lagerstandMenge      = update.lagerstandMenge
  if (update.mindestbestand       !== undefined) values.mindestbestand       = update.mindestbestand
  if (update.istFavorit           !== undefined) values.istFavorit           = update.istFavorit
  if (update.reihenfolge          !== undefined) values.reihenfolge          = update.reihenfolge
  if (update.favoritenReihenfolge !== undefined) values.favoritenReihenfolge = update.favoritenReihenfolge
  if (update.bonierdruckerId      !== undefined) values.bonierdruckerId      = update.bonierdruckerId
  if (update.bonierBeiDirektverkauf !== undefined) values.bonierBeiDirektverkauf = update.bonierBeiDirektverkauf
  if (update.istBestandteil       !== undefined) values.istBestandteil       = update.istBestandteil
  if (update.terminalSichtbar     !== undefined) values.terminalSichtbar     = update.terminalSichtbar
  if (update.bild                 !== undefined) values.bild                 = update.bild ?? null

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(artikel)
      .set(values)
      .where(eq(artikel.id, id))
      .returning()
    if (!row) return null
    // Rezept nur ersetzen, wenn explizit mitgeschickt (undefined = unverändert lassen).
    if (update.bestandteile !== undefined) {
      await schreibeRezept(tx, row.id, row.mandantId, update.bestandteile)
    }
    return row
  })

  return updated ? ladeArtikelDto(db, updated) : null
}

export async function deaktiviereArtikel(db: Db, id: string): Promise<Artikel | null> {
  return aktualisiereArtikel(db, id, { aktiv: false })
}
