import { and, desc, eq, sql } from 'drizzle-orm'
import type {
  AngebotInput,
  AngebotResponse,
  AngebotStatus,
  AngebotUpdate,
  KundeSnapshot,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { angebote, kassen, kunden } from '../db/schema.js'
import { erstelleKunde, ladeKundeSnapshot } from './kunde.service.js'

export class AngebotError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// DTO-Mapping
// ---------------------------------------------------------------------------

type AngebotRow = typeof angebote.$inferSelect

function toDto(row: AngebotRow): AngebotResponse {
  return {
    id:               row.id,
    nummer:           row.nummer,
    datum:            row.datum.toISOString(),
    status:           row.status as AngebotStatus,
    positionen:       row.positionen as AngebotResponse['positionen'],
    gesamtbetragCent: row.gesamtbetragCent,
    ...(row.gueltigBis   && { gueltigBis: row.gueltigBis }),
    ...(row.notiz        && { notiz:      row.notiz }),
    ...(row.kundeSnapshot != null ? { kunde: row.kundeSnapshot as KundeSnapshot } : {}),
    createdAt:        row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listeAngebote(
  db:        Db,
  mandantId: string,
  opts: { status?: AngebotStatus; limit?: number } = {},
): Promise<AngebotResponse[]> {
  const conditions = [eq(angebote.mandantId, mandantId)]
  if (opts.status) conditions.push(eq(angebote.status, opts.status))

  const rows = await db
    .select()
    .from(angebote)
    .where(and(...conditions))
    .orderBy(desc(angebote.createdAt))
    .limit(opts.limit ?? 100)

  return rows.map(toDto)
}

export async function holeAngebot(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<AngebotResponse> {
  const [row] = await db
    .select()
    .from(angebote)
    .where(and(eq(angebote.id, id), eq(angebote.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new AngebotError(404, 'Angebot nicht gefunden')
  return toDto(row)
}

export async function erstelleAngebot(
  db:        Db,
  mandantId: string,
  input:     AngebotInput,
): Promise<AngebotResponse> {
  // Kasse validieren
  const [kasse] = await db.select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new AngebotError(404, 'Kasse nicht gefunden')

  // Nächste Angebotsnummer
  const numRows = await db
    .select({ n: sql<number>`COALESCE(MAX(${angebote.nummer}), 0) + 1` })
    .from(angebote)
    .where(eq(angebote.mandantId, mandantId))
  const nummer = numRows[0]?.n ?? 1

  // Gesamtbetrag berechnen
  const gesamtbetragCent = input.positionen.reduce(
    (s, p) => s + Math.round(p.einzelpreisBreutto * p.menge),
    0,
  )

  // Kunde auflösen
  let kundeId:       string | undefined
  let kundeSnapshot: KundeSnapshot | undefined

  if (input.neuerKunde) {
    const neuer = await erstelleKunde(db, mandantId, input.neuerKunde)
    kundeId       = neuer.id
    kundeSnapshot = {
      id: neuer.id, nummer: neuer.nummer, bezeichnung: neuer.bezeichnung,
      firma: neuer.firma, vorname: neuer.vorname, nachname: neuer.nachname,
      email: neuer.email, telefon: neuer.telefon,
      strasse: neuer.strasse, plz: neuer.plz, ort: neuer.ort,
      land: neuer.land, uid: neuer.uid,
    }
  } else if (input.kundeId) {
    kundeSnapshot = await ladeKundeSnapshot(db, input.kundeId, mandantId)
    kundeId = input.kundeId
  }

  const [row] = await db.insert(angebote).values({
    mandantId,
    kasseId:          input.kasseId,
    nummer,
    gueltigBis:       input.gueltigBis ?? null,
    notiz:            input.notiz      ?? null,
    positionen:       input.positionen,
    gesamtbetragCent,
    ...(kundeId       && { kundeId }),
    ...(kundeSnapshot && { kundeSnapshot }),
  }).returning()

  if (!row) throw new AngebotError(500, 'Angebot konnte nicht erstellt werden')
  return toDto(row)
}

export async function aktualisiereAngebot(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     AngebotUpdate,
): Promise<AngebotResponse> {
  const [row] = await db
    .update(angebote)
    .set({
      ...(input.status     !== undefined && { status:     input.status }),
      ...(input.gueltigBis !== undefined && { gueltigBis: input.gueltigBis }),
      ...(input.notiz      !== undefined && { notiz:      input.notiz || null }),
      updatedAt: new Date(),
    })
    .where(and(eq(angebote.id, id), eq(angebote.mandantId, mandantId)))
    .returning()

  if (!row) throw new AngebotError(404, 'Angebot nicht gefunden')
  return toDto(row)
}
