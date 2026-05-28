import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import type { KundeBelegVorschau, KundeInput, KundeSnapshot, KundeUpdate } from '@kassa/shared'
import { kundeBezeichnung } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { belege, kassen, kunden } from '../db/schema.js'

export class KundeError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// DTO-Mapping
// ---------------------------------------------------------------------------

type KundeRow = typeof kunden.$inferSelect

function toDto(row: KundeRow) {
  return {
    id:          row.id,
    nummer:      row.nummer,
    bezeichnung: kundeBezeichnung(row),
    firma:       row.firma    ?? undefined,
    vorname:     row.vorname  ?? undefined,
    nachname:    row.nachname ?? undefined,
    email:       row.email    ?? undefined,
    telefon:     row.telefon  ?? undefined,
    strasse:     row.strasse  ?? undefined,
    plz:         row.plz      ?? undefined,
    ort:         row.ort      ?? undefined,
    land:        row.land,
    uid:         row.uid      ?? undefined,
    aktiv:       row.aktiv,
    kreditAktiv: row.kreditAktiv,
    notizen:     row.notizen ?? null,
    createdAt:   row.createdAt.toISOString(),
    updatedAt:   row.updatedAt.toISOString(),
  }
}

export function toSnapshot(row: KundeRow): KundeSnapshot {
  return {
    id:          row.id,
    nummer:      row.nummer,
    bezeichnung: kundeBezeichnung(row),
    firma:       row.firma    ?? undefined,
    vorname:     row.vorname  ?? undefined,
    nachname:    row.nachname ?? undefined,
    email:       row.email    ?? undefined,
    telefon:     row.telefon  ?? undefined,
    strasse:     row.strasse  ?? undefined,
    plz:         row.plz      ?? undefined,
    ort:         row.ort      ?? undefined,
    land:        row.land,
    uid:         row.uid      ?? undefined,
    kreditAktiv: row.kreditAktiv,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeKunden(
  db:        Db,
  mandantId: string,
  opts: { suche?: string; nurAktive?: boolean; limit?: number } = {},
) {
  const { suche, nurAktive = true, limit = 50 } = opts

  const conditions = [eq(kunden.mandantId, mandantId)]
  if (nurAktive) conditions.push(eq(kunden.aktiv, true))
  if (suche?.trim()) {
    const term = `%${suche.trim()}%`
    conditions.push(
      or(
        ilike(kunden.firma,    term),
        ilike(kunden.vorname,  term),
        ilike(kunden.nachname, term),
        ilike(kunden.email,    term),
        ilike(kunden.telefon,  term),
        // Kundennummer als String-Suche
        sql`${kunden.nummer}::text ILIKE ${term}`,
      )!,
    )
  }

  const rows = await db
    .select()
    .from(kunden)
    .where(and(...conditions))
    .orderBy(desc(kunden.updatedAt))
    .limit(limit)

  return rows.map(toDto)
}

export async function holeKunde(db: Db, id: string, mandantId: string) {
  const [row] = await db
    .select()
    .from(kunden)
    .where(and(eq(kunden.id, id), eq(kunden.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new KundeError(404, 'Kunde nicht gefunden')
  return toDto(row)
}

export async function erstelleKunde(db: Db, mandantId: string, input: KundeInput) {
  // Nächste Kundennummer atomisch ermitteln
  const numRows = await db
    .select({ naechsteNummer: sql<number>`COALESCE(MAX(${kunden.nummer}), 0) + 1` })
    .from(kunden)
    .where(eq(kunden.mandantId, mandantId))
  const naechsteNummer = numRows[0]?.naechsteNummer ?? 1

  const [row] = await db.insert(kunden).values({
    mandantId,
    nummer:   naechsteNummer,
    firma:    input.firma    || null,
    vorname:  input.vorname  || null,
    nachname: input.nachname || null,
    email:    input.email    || null,
    telefon:  input.telefon  || null,
    strasse:  input.strasse  || null,
    plz:      input.plz      || null,
    ort:      input.ort      || null,
    land:        input.land ?? 'AT',
    uid:         input.uid      || null,
    kreditAktiv: input.kreditAktiv ?? false,
    notizen:     input.notizen   || null,
  }).returning()

  if (!row) throw new KundeError(500, 'Kunde konnte nicht angelegt werden')
  return toDto(row)
}

export async function aktualisiereKunde(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     KundeUpdate,
) {
  const existing = await holeKunde(db, id, mandantId)
  if (!existing.aktiv && input.aktiv !== true) {
    throw new KundeError(409, 'Inaktiver Kunde — erst reaktivieren')
  }

  const [row] = await db
    .update(kunden)
    .set({
      ...(input.firma    !== undefined && { firma:    input.firma    || null }),
      ...(input.vorname  !== undefined && { vorname:  input.vorname  || null }),
      ...(input.nachname !== undefined && { nachname: input.nachname || null }),
      ...(input.email    !== undefined && { email:    input.email    || null }),
      ...(input.telefon  !== undefined && { telefon:  input.telefon  || null }),
      ...(input.strasse  !== undefined && { strasse:  input.strasse  || null }),
      ...(input.plz      !== undefined && { plz:      input.plz      || null }),
      ...(input.ort      !== undefined && { ort:      input.ort      || null }),
      ...(input.land     !== undefined && { land:     input.land }),
      ...(input.uid        !== undefined && { uid:        input.uid      || null }),
      ...(input.aktiv      !== undefined && { aktiv:      input.aktiv }),
      ...(input.kreditAktiv !== undefined && { kreditAktiv: input.kreditAktiv }),
      ...(input.notizen     !== undefined && { notizen:    input.notizen || null }),
      updatedAt: new Date(),
    })
    .where(and(eq(kunden.id, id), eq(kunden.mandantId, mandantId)))
    .returning()

  if (!row) throw new KundeError(404, 'Kunde nicht gefunden')
  return toDto(row)
}

export async function listeBelegeVonKunde(
  db:        Db,
  kundeId:   string,
  mandantId: string,
  limit      = 100,
): Promise<KundeBelegVorschau[]> {
  const rows = await db
    .select({
      id:               belege.id,
      belegNummer:      belege.belegNummer,
      belegDatum:       belege.belegDatum,
      belegTyp:         belege.belegTyp,
      betragNormal:     belege.betragNormalCent,
      betragErm1:       belege.betragErmaessigt1Cent,
      betragErm2:       belege.betragErmaessigt2Cent,
      betragNull:       belege.betragNullCent,
      betragBes:        belege.betragBesondersCent,
      summeBarCent:     belege.summeBarCent,
      summeKarteCent:   belege.summeKarteCent,
    })
    .from(belege)
    .innerJoin(kassen, eq(belege.kasseId, kassen.id))
    .where(and(eq(belege.kundeId, kundeId), eq(kassen.mandantId, mandantId)))
    .orderBy(desc(belege.belegDatum))
    .limit(limit)

  return rows.map(r => ({
    id:               r.id,
    belegNummer:      r.belegNummer,
    belegDatum:       r.belegDatum.toISOString(),
    belegTyp:         r.belegTyp,
    gesamtbetragCent: r.betragNormal + r.betragErm1 + r.betragErm2 + r.betragNull + r.betragBes,
    summeBarCent:     r.summeBarCent,
    summeKarteCent:   r.summeKarteCent,
  }))
}

export async function ladeKundeSnapshot(
  db:        Db,
  kundeId:   string,
  mandantId: string,
): Promise<KundeSnapshot> {
  const [row] = await db
    .select()
    .from(kunden)
    .where(and(eq(kunden.id, kundeId), eq(kunden.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new KundeError(404, `Kunde ${kundeId} nicht gefunden`)
  return toSnapshot(row)
}
