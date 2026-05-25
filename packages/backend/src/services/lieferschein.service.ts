import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  LiferscheinInput,
  LiferscheinResponse,
  LiferscheinStatus,
  LiferscheinUpdate,
  KundeSnapshot,
  SammelrechnungInput,
  SammelrechnungResponse,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  angebote,
  lieferscheine,
  sammelrechnungen,
} from '../db/schema.js'

export class LiferscheinError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// DTO-Mapping
// ---------------------------------------------------------------------------

type LiferscheinRow = typeof lieferscheine.$inferSelect & {
  angebotNummer: number
}

function toDto(row: LiferscheinRow): LiferscheinResponse {
  return {
    id:            row.id,
    nummer:        row.nummer,
    datum:         row.datum.toISOString(),
    status:        row.status as LiferscheinStatus,
    angebotId:     row.angebotId,
    angebotNummer: row.angebotNummer,
    positionen:    row.positionen as LiferscheinResponse['positionen'],
    ...(row.notiz         && { notiz: row.notiz }),
    ...(row.kundeSnapshot != null
      ? { kunde: row.kundeSnapshot as KundeSnapshot }
      : {}),
    createdAt:     row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Queries mit Angebots-Join (für angebotNummer)
// ---------------------------------------------------------------------------

async function listeQuery(
  db:        Db,
  mandantId: string,
  opts: { kundeId?: string; angebotId?: string; status?: LiferscheinStatus; limit?: number } = {},
): Promise<LiferscheinRow[]> {
  const conditions = [eq(lieferscheine.mandantId, mandantId)]
  if (opts.kundeId)   conditions.push(eq(lieferscheine.kundeId,   opts.kundeId))
  if (opts.angebotId) conditions.push(eq(lieferscheine.angebotId, opts.angebotId))
  if (opts.status)    conditions.push(eq(lieferscheine.status,    opts.status))

  const rows = await db
    .select({
      id:            lieferscheine.id,
      mandantId:     lieferscheine.mandantId,
      kasseId:       lieferscheine.kasseId,
      angebotId:     lieferscheine.angebotId,
      angebotNummer: angebote.nummer,
      nummer:        lieferscheine.nummer,
      datum:         lieferscheine.datum,
      status:        lieferscheine.status,
      notiz:         lieferscheine.notiz,
      positionen:    lieferscheine.positionen,
      kundeId:       lieferscheine.kundeId,
      kundeSnapshot: lieferscheine.kundeSnapshot,
      createdAt:     lieferscheine.createdAt,
      updatedAt:     lieferscheine.updatedAt,
    })
    .from(lieferscheine)
    .innerJoin(angebote, eq(lieferscheine.angebotId, angebote.id))
    .where(and(...conditions))
    .orderBy(desc(lieferscheine.createdAt))
    .limit(opts.limit ?? 200)

  return rows
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeLiferscheine(
  db:        Db,
  mandantId: string,
  opts: { kundeId?: string; angebotId?: string; status?: LiferscheinStatus; limit?: number } = {},
): Promise<LiferscheinResponse[]> {
  const rows = await listeQuery(db, mandantId, opts)
  return rows.map(toDto)
}

export async function holeLiferschein(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<LiferscheinResponse> {
  const rows = await listeQuery(db, mandantId, { limit: 1 })
  const row  = rows.find(r => r.id === id)
    ?? await (async () => {
      const rs = await db
        .select({
          id:            lieferscheine.id,
          mandantId:     lieferscheine.mandantId,
          kasseId:       lieferscheine.kasseId,
          angebotId:     lieferscheine.angebotId,
          angebotNummer: angebote.nummer,
          nummer:        lieferscheine.nummer,
          datum:         lieferscheine.datum,
          status:        lieferscheine.status,
          notiz:         lieferscheine.notiz,
          positionen:    lieferscheine.positionen,
          kundeId:       lieferscheine.kundeId,
          kundeSnapshot: lieferscheine.kundeSnapshot,
          createdAt:     lieferscheine.createdAt,
          updatedAt:     lieferscheine.updatedAt,
        })
        .from(lieferscheine)
        .innerJoin(angebote, eq(lieferscheine.angebotId, angebote.id))
        .where(and(eq(lieferscheine.id, id), eq(lieferscheine.mandantId, mandantId)))
        .limit(1)
      return rs[0] ?? null
    })()

  if (!row) throw new LiferscheinError(404, 'Lieferschein nicht gefunden')
  return toDto(row)
}

export async function erstelleLiferschein(
  db:        Db,
  mandantId: string,
  input:     LiferscheinInput,
): Promise<LiferscheinResponse> {
  // Angebot laden + validieren
  const [angebot] = await db
    .select()
    .from(angebote)
    .where(and(eq(angebote.id, input.angebotId), eq(angebote.mandantId, mandantId)))
    .limit(1)
  if (!angebot) throw new LiferscheinError(404, 'Angebot nicht gefunden')

  // Nächste Lieferscheinnummer
  const numRows = await db
    .select({ n: sql<number>`COALESCE(MAX(${lieferscheine.nummer}), 0) + 1` })
    .from(lieferscheine)
    .where(eq(lieferscheine.mandantId, mandantId))
  const nummer = numRows[0]?.n ?? 1

  const [row] = await db
    .insert(lieferscheine)
    .values({
      mandantId,
      kasseId:    angebot.kasseId,
      angebotId:  angebot.id,
      nummer,
      positionen: angebot.positionen,
      ...(input.notiz       ? { notiz:         input.notiz }          : {}),
      ...(angebot.kundeId   ? { kundeId:       angebot.kundeId }       : {}),
      ...(angebot.kundeSnapshot ? { kundeSnapshot: angebot.kundeSnapshot } : {}),
    })
    .returning()

  if (!row) throw new LiferscheinError(500, 'Lieferschein konnte nicht erstellt werden')

  return toDto({ ...row, angebotNummer: angebot.nummer })
}

export async function aktualisiereLiferschein(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     LiferscheinUpdate,
): Promise<LiferscheinResponse> {
  const [row] = await db
    .update(lieferscheine)
    .set({
      ...(input.status !== undefined && { status:    input.status }),
      ...(input.notiz  !== undefined && { notiz:     input.notiz || null }),
      updatedAt: new Date(),
    })
    .where(and(eq(lieferscheine.id, id), eq(lieferscheine.mandantId, mandantId)))
    .returning()

  if (!row) throw new LiferscheinError(404, 'Lieferschein nicht gefunden')
  return holeLiferschein(db, row.id, mandantId)
}

// ---------------------------------------------------------------------------
// Sammelrechnung
// ---------------------------------------------------------------------------

export async function erstelleSammelrechnung(
  db:        Db,
  mandantId: string,
  input:     SammelrechnungInput,
): Promise<SammelrechnungResponse> {
  if (input.lieferscheinIds.length === 0)
    throw new LiferscheinError(400, 'Mindestens ein Lieferschein erforderlich')

  // Alle Lieferscheine laden
  const rows = await db
    .select({
      id:            lieferscheine.id,
      mandantId:     lieferscheine.mandantId,
      kasseId:       lieferscheine.kasseId,
      angebotId:     lieferscheine.angebotId,
      angebotNummer: angebote.nummer,
      nummer:        lieferscheine.nummer,
      datum:         lieferscheine.datum,
      status:        lieferscheine.status,
      notiz:         lieferscheine.notiz,
      positionen:    lieferscheine.positionen,
      kundeId:       lieferscheine.kundeId,
      kundeSnapshot: lieferscheine.kundeSnapshot,
      createdAt:     lieferscheine.createdAt,
      updatedAt:     lieferscheine.updatedAt,
    })
    .from(lieferscheine)
    .innerJoin(angebote, eq(lieferscheine.angebotId, angebote.id))
    .where(
      and(
        eq(lieferscheine.mandantId, mandantId),
        inArray(lieferscheine.id, input.lieferscheinIds),
      ),
    )

  if (rows.length === 0)
    throw new LiferscheinError(404, 'Keine gültigen Lieferscheine gefunden')

  if (rows.some(r => r.status !== 'offen'))
    throw new LiferscheinError(400, 'Nur offene Lieferscheine können zu einer Sammelrechnung zusammengefasst werden')

  // Gesamtbetrag über alle Positionen
  type Pos = { einzelpreisBreutto: number; menge: number }
  const gesamtbetragCent = rows.reduce((sum, r) => {
    const positionen = r.positionen as Pos[]
    return sum + positionen.reduce((s, p) => s + Math.round(p.einzelpreisBreutto * p.menge), 0)
  }, 0)

  // Kunde vom ersten Lieferschein
  const ersterRow    = rows[0]!
  const kundeId      = ersterRow.kundeId      ?? undefined
  const kundeSnapshot = ersterRow.kundeSnapshot ?? undefined

  // Nächste Sammelrechnungsnummer
  const numRows = await db
    .select({ n: sql<number>`COALESCE(MAX(${sammelrechnungen.nummer}), 0) + 1` })
    .from(sammelrechnungen)
    .where(eq(sammelrechnungen.mandantId, mandantId))
  const nummer = numRows[0]?.n ?? 1

  // Sammelrechnung speichern
  const [srRow] = await db
    .insert(sammelrechnungen)
    .values({
      mandantId,
      nummer,
      lieferscheinIds:  input.lieferscheinIds,
      gesamtbetragCent,
      ...(kundeId       ? { kundeId }        : {}),
      ...(kundeSnapshot ? { kundeSnapshot }  : {}),
    })
    .returning()

  if (!srRow) throw new LiferscheinError(500, 'Sammelrechnung konnte nicht erstellt werden')

  // Lieferscheine als 'abgeschlossen' markieren
  await db
    .update(lieferscheine)
    .set({ status: 'abgeschlossen', updatedAt: new Date() })
    .where(
      and(
        eq(lieferscheine.mandantId, mandantId),
        inArray(lieferscheine.id, input.lieferscheinIds),
      ),
    )

  // Sortierte DTOs zurückgeben
  const sortedRows = [...rows].sort((a, b) => a.nummer - b.nummer)

  return {
    id:               srRow.id,
    nummer:           srRow.nummer,
    datum:            srRow.datum.toISOString(),
    ...(kundeSnapshot ? { kunde: kundeSnapshot as KundeSnapshot } : {}),
    lieferscheine:    sortedRows.map(toDto),
    gesamtbetragCent,
    createdAt:        srRow.createdAt.toISOString(),
  }
}
