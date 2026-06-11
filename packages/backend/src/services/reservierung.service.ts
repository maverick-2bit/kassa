import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, mandanten, reservierungen } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import type {
  ReservierungInput,
  ReservierungResponse,
  ReservierungStatus,
  ReservierungUpdate,
  OnlineBuchungInfo,
} from '@kassa/shared'

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function erstelleReservierung(
  db:        Db,
  mandantId: string,
  input:     ReservierungInput,
  quelle:    'intern' | 'online' = 'intern',
): Promise<ReservierungResponse> {
  const [kasse] = await db
    .select({ id: kassen.id, mandantId: kassen.mandantId })
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new Error('Kasse nicht gefunden')

  const status = quelle === 'online' ? 'wartend' : 'bestaetigt'

  const [row] = await db
    .insert(reservierungen)
    .values({
      mandantId,
      kasseId:        input.kasseId,
      datum:          input.datum,
      zeitVon:        input.zeitVon,
      dauer:          input.dauer ?? 90,
      personenAnzahl: input.personenAnzahl,
      name:           input.name,
      status,
      quelle,
      ...(input.telefon   && { telefon:   input.telefon   }),
      ...(input.email     && { email:     input.email     }),
      ...(input.notiz     && { notiz:     input.notiz     }),
      ...(input.tischLabel && { tischLabel: input.tischLabel }),
    })
    .returning()

  if (!row) throw new Error('Reservierung konnte nicht gespeichert werden')

  if (quelle === 'online') {
    emitKasseEvent(mandantId, {
      typ:          'neue_reservierung',
      reservierungId: row.id,
      kasseId:      input.kasseId,
      datum:        input.datum,
      zeitVon:      input.zeitVon,
      name:         input.name,
    })
  }

  return toDto(row)
}

export async function listeReservierungen(
  db:        Db,
  mandantId: string,
  opts: {
    kasseId?: string
    datumVon?: string
    datumBis?: string
    limit?: number
  } = {},
): Promise<ReservierungResponse[]> {
  const conditions = [eq(reservierungen.mandantId, mandantId)]

  if (opts.kasseId) conditions.push(eq(reservierungen.kasseId, opts.kasseId))
  if (opts.datumVon) conditions.push(gte(reservierungen.datum, opts.datumVon))
  if (opts.datumBis) conditions.push(lte(reservierungen.datum, opts.datumBis))

  const rows = await db
    .select()
    .from(reservierungen)
    .where(and(...conditions))
    .orderBy(reservierungen.datum, reservierungen.zeitVon)
    .limit(opts.limit ?? 500)

  return rows.map(toDto)
}

export async function aktualisiereReservierung(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     ReservierungUpdate,
): Promise<ReservierungResponse> {
  const [row] = await db
    .update(reservierungen)
    .set({
      ...( input.datum          !== undefined && { datum:          input.datum          }),
      ...( input.zeitVon        !== undefined && { zeitVon:        input.zeitVon        }),
      ...( input.dauer          !== undefined && { dauer:          input.dauer          }),
      ...( input.personenAnzahl !== undefined && { personenAnzahl: input.personenAnzahl }),
      ...( input.name           !== undefined && { name:           input.name           }),
      ...( input.telefon        !== undefined && { telefon:        input.telefon        }),
      ...( input.email          !== undefined && { email:          input.email          }),
      ...( input.notiz          !== undefined && { notiz:          input.notiz          }),
      ...( input.tischLabel     !== undefined && { tischLabel:     input.tischLabel     }),
      ...( input.status         !== undefined && { status:         input.status         }),
      updatedAt: new Date(),
    })
    .where(and(eq(reservierungen.id, id), eq(reservierungen.mandantId, mandantId)))
    .returning()

  if (!row) throw new Error('Reservierung nicht gefunden')
  return toDto(row)
}

export async function loescheReservierung(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<void> {
  const result = await db
    .delete(reservierungen)
    .where(and(eq(reservierungen.id, id), eq(reservierungen.mandantId, mandantId)))
    .returning({ id: reservierungen.id })

  if (result.length === 0) throw new Error('Reservierung nicht gefunden')
}

// ---------------------------------------------------------------------------
// Öffentliche Buchung (kein JWT)
// ---------------------------------------------------------------------------

export async function ladeOnlineBuchungInfo(
  db:      Db,
  kasseId: string,
): Promise<OnlineBuchungInfo> {
  const [row] = await db
    .select({
      kasseId:           kassen.id,
      mandantId:         kassen.mandantId,
      onlineBuchungAktiv: kassen.onlineBuchungAktiv,
    })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)

  if (!row) throw new Error('Kasse nicht gefunden')

  const [mandant] = await db
    .select({ firmenname: mandanten.firmenname, modulReservierungenAktiv: mandanten.modulReservierungenAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, row.mandantId))
    .limit(1)

  const aktiv = !!(mandant?.modulReservierungenAktiv && row.onlineBuchungAktiv)

  return {
    kasseId:    row.kasseId,
    firmenname: mandant?.firmenname ?? '',
    aktiv,
  }
}

export async function erstelleOnlineReservierung(
  db:      Db,
  kasseId: string,
  input:   Omit<ReservierungInput, 'kasseId'>,
): Promise<ReservierungResponse> {
  const [kasse] = await db
    .select({ mandantId: kassen.mandantId, onlineBuchungAktiv: kassen.onlineBuchungAktiv })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)

  if (!kasse) throw new Error('Kasse nicht gefunden')
  if (!kasse.onlineBuchungAktiv) throw new Error('Online-Buchung nicht aktiviert')

  const [mandant] = await db
    .select({ modulReservierungenAktiv: mandanten.modulReservierungenAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, kasse.mandantId))
    .limit(1)

  if (!mandant?.modulReservierungenAktiv) throw new Error('Reservierungs-Modul nicht aktiviert')

  return erstelleReservierung(db, kasse.mandantId, { ...input, kasseId }, 'online')
}

// ---------------------------------------------------------------------------
// Stornierung via Online-Token
// ---------------------------------------------------------------------------

export async function storniereViaToken(
  db:          Db,
  kasseId:     string,
  onlineToken: string,
): Promise<void> {
  const [row] = await db
    .select({ id: reservierungen.id, mandantId: reservierungen.mandantId, status: reservierungen.status })
    .from(reservierungen)
    .where(and(eq(reservierungen.kasseId, kasseId), eq(reservierungen.onlineToken, onlineToken)))
    .limit(1)

  if (!row) throw new Error('Reservierung nicht gefunden')
  if (row.status === 'storniert') throw new Error('Bereits storniert')
  if (row.status === 'erschienen') throw new Error('Stornierung nicht mehr möglich')

  await db
    .update(reservierungen)
    .set({ status: 'storniert', updatedAt: new Date() })
    .where(eq(reservierungen.id, row.id))
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function toDto(row: typeof reservierungen.$inferSelect): ReservierungResponse {
  return {
    id:             row.id,
    kasseId:        row.kasseId,
    datum:          row.datum,
    zeitVon:        row.zeitVon,
    dauer:          row.dauer,
    personenAnzahl: row.personenAnzahl,
    name:           row.name,
    status:         row.status as ReservierungStatus,
    quelle:         row.quelle as 'intern' | 'online',
    onlineToken:    row.onlineToken,
    ...(row.telefon   && { telefon:    row.telefon   }),
    ...(row.email     && { email:      row.email     }),
    ...(row.notiz     && { notiz:      row.notiz     }),
    ...(row.tischLabel && { tischLabel: row.tischLabel }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
