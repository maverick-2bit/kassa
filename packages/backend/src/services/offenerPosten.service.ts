import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type {
  KundeSnapshot,
  OffenerPostenInput,
  OffenerPostenResponse,
  OffenerPostenStatus,
  OffenerPostenZahlung,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { belege, kunden, offenePosten } from '../db/schema.js'

export class OffenerPostenError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// DTO-Mapping
// ---------------------------------------------------------------------------

type OpRow = typeof offenePosten.$inferSelect & {
  belegNummer: number | null
}

function toDto(row: OpRow): OffenerPostenResponse {
  const restCent = Math.max(0, row.betragCent - row.bezahltCent)
  return {
    id:          row.id,
    nummer:      row.nummer,
    datum:       row.datum.toISOString(),
    status:      row.status as OffenerPostenStatus,
    kundeId:     row.kundeId,
    ...(row.kundeSnapshot != null ? { kunde: row.kundeSnapshot as KundeSnapshot } : {}),
    ...(row.belegId     ? { belegId: row.belegId }           : {}),
    ...(row.belegNummer ? { belegNummer: row.belegNummer }   : {}),
    betragCent:  row.betragCent,
    bezahltCent: row.bezahltCent,
    restCent,
    ...(row.notiz ? { notiz: row.notiz } : {}),
    createdAt:   row.createdAt.toISOString(),
    updatedAt:   row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Abfragen
// ---------------------------------------------------------------------------

async function listeQuery(
  db:        Db,
  mandantId: string,
  opts: { kundeId?: string; status?: OffenerPostenStatus; limit?: number } = {},
): Promise<OpRow[]> {
  const conditions = [eq(offenePosten.mandantId, mandantId)]
  if (opts.kundeId) conditions.push(eq(offenePosten.kundeId, opts.kundeId))
  if (opts.status)  conditions.push(eq(offenePosten.status,  opts.status))

  const rows = await db
    .select({
      id:            offenePosten.id,
      mandantId:     offenePosten.mandantId,
      nummer:        offenePosten.nummer,
      datum:         offenePosten.datum,
      status:        offenePosten.status,
      kundeId:       offenePosten.kundeId,
      kundeSnapshot: offenePosten.kundeSnapshot,
      belegId:       offenePosten.belegId,
      belegNummer:   belege.belegNummer,
      betragCent:    offenePosten.betragCent,
      bezahltCent:   offenePosten.bezahltCent,
      notiz:         offenePosten.notiz,
      createdAt:     offenePosten.createdAt,
      updatedAt:     offenePosten.updatedAt,
    })
    .from(offenePosten)
    .leftJoin(belege, eq(offenePosten.belegId, belege.id))
    .where(and(...conditions))
    .orderBy(desc(offenePosten.datum))
    .limit(opts.limit ?? 500)

  return rows
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeOffenePosten(
  db:        Db,
  mandantId: string,
  opts: { kundeId?: string; status?: OffenerPostenStatus; limit?: number } = {},
): Promise<OffenerPostenResponse[]> {
  const rows = await listeQuery(db, mandantId, opts)
  return rows.map(toDto)
}

export async function holeOffenerPosten(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<OffenerPostenResponse> {
  const rows = await db
    .select({
      id:            offenePosten.id,
      mandantId:     offenePosten.mandantId,
      nummer:        offenePosten.nummer,
      datum:         offenePosten.datum,
      status:        offenePosten.status,
      kundeId:       offenePosten.kundeId,
      kundeSnapshot: offenePosten.kundeSnapshot,
      belegId:       offenePosten.belegId,
      belegNummer:   belege.belegNummer,
      betragCent:    offenePosten.betragCent,
      bezahltCent:   offenePosten.bezahltCent,
      notiz:         offenePosten.notiz,
      createdAt:     offenePosten.createdAt,
      updatedAt:     offenePosten.updatedAt,
    })
    .from(offenePosten)
    .leftJoin(belege, eq(offenePosten.belegId, belege.id))
    .where(and(eq(offenePosten.id, id), eq(offenePosten.mandantId, mandantId)))
    .limit(1)

  if (!rows[0]) throw new OffenerPostenError(404, 'Offener Posten nicht gefunden')
  return toDto(rows[0])
}

export async function erstelleOffenerPosten(
  db:        Db,
  mandantId: string,
  input:     OffenerPostenInput,
): Promise<OffenerPostenResponse> {
  // Kunden-Snapshot aufbauen
  const [kunde] = await db
    .select()
    .from(kunden)
    .where(and(eq(kunden.id, input.kundeId), eq(kunden.mandantId, mandantId)))
    .limit(1)

  if (!kunde) throw new OffenerPostenError(404, 'Kunde nicht gefunden')

  const bezeichnung = [kunde.firma, kunde.vorname, kunde.nachname].filter(Boolean).join(' ').trim()
  const kundeSnapshot: KundeSnapshot = {
    id:          kunde.id,
    nummer:      kunde.nummer,
    bezeichnung: bezeichnung || `Kunde ${kunde.nummer}`,
    ...(kunde.firma    && { firma:    kunde.firma    }),
    ...(kunde.vorname  && { vorname:  kunde.vorname  }),
    ...(kunde.nachname && { nachname: kunde.nachname }),
    ...(kunde.email    && { email:    kunde.email    }),
    ...(kunde.telefon  && { telefon:  kunde.telefon  }),
    ...(kunde.strasse  && { strasse:  kunde.strasse  }),
    ...(kunde.plz      && { plz:      kunde.plz      }),
    ...(kunde.ort      && { ort:      kunde.ort      }),
    land: kunde.land,
    ...(kunde.uid      && { uid:      kunde.uid      }),
  }

  // Nächste Nummer
  const numRows = await db
    .select({ n: sql<number>`COALESCE(MAX(${offenePosten.nummer}), 0) + 1` })
    .from(offenePosten)
    .where(eq(offenePosten.mandantId, mandantId))
  const nummer = numRows[0]?.n ?? 1

  const [row] = await db
    .insert(offenePosten)
    .values({
      mandantId,
      nummer,
      kundeId:       input.kundeId,
      kundeSnapshot,
      betragCent:    input.betragCent,
      ...(input.belegId ? { belegId: input.belegId } : {}),
      ...(input.notiz   ? { notiz:   input.notiz   } : {}),
    })
    .returning()

  if (!row) throw new OffenerPostenError(500, 'Offener Posten konnte nicht erstellt werden')
  return holeOffenerPosten(db, row.id, mandantId)
}

export async function erfasseZahlung(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     OffenerPostenZahlung,
): Promise<OffenerPostenResponse> {
  // Aktuellen Stand laden
  const [current] = await db
    .select()
    .from(offenePosten)
    .where(and(eq(offenePosten.id, id), eq(offenePosten.mandantId, mandantId)))
    .limit(1)

  if (!current) throw new OffenerPostenError(404, 'Offener Posten nicht gefunden')
  if (current.status === 'bezahlt') throw new OffenerPostenError(400, 'Dieser Posten ist bereits vollständig bezahlt')

  const neuBezahlt = current.bezahltCent + input.zahlungCent
  if (neuBezahlt > current.betragCent) {
    throw new OffenerPostenError(400, `Zahlung (${(input.zahlungCent / 100).toFixed(2)} €) übersteigt den Restbetrag (${((current.betragCent - current.bezahltCent) / 100).toFixed(2)} €)`)
  }

  const neuerStatus: OffenerPostenStatus =
    neuBezahlt >= current.betragCent ? 'bezahlt' : 'teilbezahlt'

  const [updated] = await db
    .update(offenePosten)
    .set({
      bezahltCent: neuBezahlt,
      status:      neuerStatus,
      ...(input.notiz !== undefined && { notiz: input.notiz || null }),
      updatedAt:   new Date(),
    })
    .where(and(eq(offenePosten.id, id), eq(offenePosten.mandantId, mandantId)))
    .returning()

  if (!updated) throw new OffenerPostenError(500, 'Zahlung konnte nicht erfasst werden')
  return holeOffenerPosten(db, updated.id, mandantId)
}

// ---------------------------------------------------------------------------
// Statistik-Übersicht
// ---------------------------------------------------------------------------

export async function offenePostenStatistik(
  db:        Db,
  mandantId: string,
): Promise<{ anzahl: number; gesamtRestCent: number }> {
  const rows = await db
    .select({
      betragCent:  offenePosten.betragCent,
      bezahltCent: offenePosten.bezahltCent,
    })
    .from(offenePosten)
    .where(
      and(
        eq(offenePosten.mandantId, mandantId),
        // Nicht vollständig bezahlte Posten
        sql`${offenePosten.status} != 'bezahlt'`,
      ),
    )

  return {
    anzahl:        rows.length,
    gesamtRestCent: rows.reduce((s, r) => s + Math.max(0, r.betragCent - r.bezahltCent), 0),
  }
}
