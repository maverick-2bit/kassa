/**
 * Preislisten — Sonderpreise je Kunde.
 *
 * Mandantentrennung: jede Abfrage/Änderung über `mandantId`; Artikel einer Preisliste und die Zuweisung an
 * Kunden werden gegen den Mandanten geprüft. Das Löschen einer Liste gibt ihre Kunden frei (FK SET NULL).
 */

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import type {
  Preisliste, PreislisteDetail, PreislisteFuerKunde, PreislisteInput, PreislistePreiseSetzen, PreislisteUpdate,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, kunden, preislisten, preislistenPreise } from '../db/schema.js'

export class PreislisteError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

const istNameKollision = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (
    (err as { code?: string }).code === '23505' ||
    (err as { cause?: { code?: string } }).cause?.code === '23505'
  )

type Row = typeof preislisten.$inferSelect

function dto(row: Row, anzahlPreise: number, anzahlKunden: number): Preisliste {
  return {
    id: row.id, mandantId: row.mandantId, name: row.name, aktiv: row.aktiv,
    anzahlPreise, anzahlKunden,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }
}

async function ladeRow(db: Db, id: string, mandantId: string): Promise<Row> {
  const [r] = await db.select().from(preislisten)
    .where(and(eq(preislisten.id, id), eq(preislisten.mandantId, mandantId))).limit(1)
  if (!r) throw new PreislisteError(404, 'Preisliste nicht gefunden')
  return r
}

async function zaehlungen(db: Db, ids: string[]): Promise<{ preise: Map<string, number>; kunden: Map<string, number> }> {
  if (ids.length === 0) return { preise: new Map(), kunden: new Map() }
  const p = await db.select({ id: preislistenPreise.preislisteId, n: count() }).from(preislistenPreise)
    .where(inArray(preislistenPreise.preislisteId, ids)).groupBy(preislistenPreise.preislisteId)
  const k = await db.select({ id: kunden.preislisteId, n: count() }).from(kunden)
    .where(and(inArray(kunden.preislisteId, ids), eq(kunden.aktiv, true))).groupBy(kunden.preislisteId)
  return {
    preise: new Map(p.map(x => [x.id, Number(x.n)])),
    kunden: new Map(k.flatMap(x => x.id ? [[x.id, Number(x.n)] as const] : [])),
  }
}

export async function listePreislisten(db: Db, mandantId: string): Promise<Preisliste[]> {
  const rows = await db.select().from(preislisten).where(eq(preislisten.mandantId, mandantId)).orderBy(asc(preislisten.name))
  const z = await zaehlungen(db, rows.map(r => r.id))
  return rows.map(r => dto(r, z.preise.get(r.id) ?? 0, z.kunden.get(r.id) ?? 0))
}

export async function holePreisliste(db: Db, id: string, mandantId: string): Promise<PreislisteDetail> {
  const row = await ladeRow(db, id, mandantId)
  const eintraege = await db
    .select({
      artikelId: artikel.id, artikelBezeichnung: artikel.bezeichnung, regulaerBruttoCent: artikel.preisBruttoCent,
      artikelAktiv: artikel.aktiv, preisBruttoCent: preislistenPreise.preisBruttoCent,
    })
    .from(preislistenPreise)
    .innerJoin(artikel, eq(artikel.id, preislistenPreise.artikelId))
    .where(eq(preislistenPreise.preislisteId, id))
    .orderBy(asc(artikel.bezeichnung))
  const z = await zaehlungen(db, [id])
  return { ...dto(row, eintraege.length, z.kunden.get(id) ?? 0), preise: eintraege }
}

export async function erstellePreisliste(db: Db, mandantId: string, input: PreislisteInput): Promise<Preisliste> {
  try {
    const [row] = await db.insert(preislisten).values({ mandantId, name: input.name }).returning()
    return dto(row!, 0, 0)
  } catch (err) {
    if (istNameKollision(err)) throw new PreislisteError(409, `Es gibt schon eine Preisliste „${input.name}"`)
    throw err
  }
}

export async function aktualisierePreisliste(db: Db, id: string, mandantId: string, update: PreislisteUpdate): Promise<Preisliste> {
  await ladeRow(db, id, mandantId)
  try {
    await db.update(preislisten).set({
      ...(update.name  !== undefined && { name: update.name }),
      ...(update.aktiv !== undefined && { aktiv: update.aktiv }),
      updatedAt: new Date(),
    }).where(and(eq(preislisten.id, id), eq(preislisten.mandantId, mandantId)))
  } catch (err) {
    if (istNameKollision(err)) throw new PreislisteError(409, `Es gibt schon eine Preisliste „${update.name}"`)
    throw err
  }
  const row = await ladeRow(db, id, mandantId)
  const z = await zaehlungen(db, [id])
  return dto(row, z.preise.get(id) ?? 0, z.kunden.get(id) ?? 0)
}

/** Löscht Liste samt Preisen; zugewiesene Kunden fallen auf die normalen Preise zurück. */
export async function loeschePreisliste(db: Db, id: string, mandantId: string): Promise<void> {
  await ladeRow(db, id, mandantId)
  await db.delete(preislisten).where(and(eq(preislisten.id, id), eq(preislisten.mandantId, mandantId)))
}

/** Preise setzen/überschreiben (Upsert je Artikel). Alle Artikel müssen zum Mandanten gehören. */
export async function setzePreise(db: Db, id: string, mandantId: string, input: PreislistePreiseSetzen): Promise<PreislisteDetail> {
  await ladeRow(db, id, mandantId)
  // doppelte Artikel in der Anfrage: der letzte Wert gilt
  const jeArtikel = new Map(input.preise.map(p => [p.artikelId, p.preisBruttoCent] as const))
  const ids = [...jeArtikel.keys()]
  const vorhanden = await db.select({ id: artikel.id }).from(artikel)
    .where(and(eq(artikel.mandantId, mandantId), inArray(artikel.id, ids)))
  if (vorhanden.length !== ids.length) throw new PreislisteError(404, 'Ein Artikel wurde nicht gefunden')

  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i += 500) {
      const teil = ids.slice(i, i + 500)
      await tx.insert(preislistenPreise)
        .values(teil.map(artikelId => ({ preislisteId: id, artikelId, preisBruttoCent: jeArtikel.get(artikelId)! })))
        .onConflictDoUpdate({
          target: [preislistenPreise.preislisteId, preislistenPreise.artikelId],
          set: { preisBruttoCent: sql`excluded.preis_brutto_cent` },
        })
    }
    await tx.update(preislisten).set({ updatedAt: new Date() }).where(eq(preislisten.id, id))
  })
  return holePreisliste(db, id, mandantId)
}

export async function entfernePreis(db: Db, id: string, mandantId: string, artikelId: string): Promise<void> {
  await ladeRow(db, id, mandantId)
  const geloescht = await db.delete(preislistenPreise)
    .where(and(eq(preislistenPreise.preislisteId, id), eq(preislistenPreise.artikelId, artikelId)))
    .returning({ id: preislistenPreise.id })
  if (geloescht.length === 0) throw new PreislisteError(404, 'Für diesen Artikel gibt es keinen Sonderpreis')
}

/** Preisliste eines Kunden für die Kasse; null wenn keine zugewiesen oder die Liste deaktiviert ist. */
export async function preislisteFuerKunde(db: Db, kundeId: string, mandantId: string): Promise<PreislisteFuerKunde> {
  const [k] = await db.select({ preislisteId: kunden.preislisteId }).from(kunden)
    .where(and(eq(kunden.id, kundeId), eq(kunden.mandantId, mandantId))).limit(1)
  if (!k) throw new PreislisteError(404, 'Kunde nicht gefunden')
  if (!k.preislisteId) return null
  const [liste] = await db.select().from(preislisten)
    .where(and(eq(preislisten.id, k.preislisteId), eq(preislisten.mandantId, mandantId), eq(preislisten.aktiv, true))).limit(1)
  if (!liste) return null
  const preise = await db.select({ artikelId: preislistenPreise.artikelId, preisBruttoCent: preislistenPreise.preisBruttoCent })
    .from(preislistenPreise).where(eq(preislistenPreise.preislisteId, liste.id))
  return { preislisteId: liste.id, name: liste.name, preise }
}
