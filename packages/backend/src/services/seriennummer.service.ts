/**
 * Seriennummer-Service — striktes Pool-Modell PRO ARTIKEL.
 * Erfassung im Wareneingang (Status 'verfuegbar'); der Verkaufs-Übergang auf
 * 'verkauft' (Lieferschein/Rechnung) folgt in den Sale-Services.
 */

import { and, eq } from 'drizzle-orm'
import type { Seriennummer, SeriennummernErfassenInput } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, seriennummern } from '../db/schema.js'

export class SeriennummerError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

function toDto(row: typeof seriennummern.$inferSelect): Seriennummer {
  return {
    id:             row.id,
    artikelId:      row.artikelId,
    seriennummer:   row.seriennummer,
    status:         row.status as 'verfuegbar' | 'verkauft',
    belegId:        row.belegId,
    lieferscheinId: row.lieferscheinId,
    verkauftAm:     row.verkauftAm ? row.verkauftAm.toISOString() : null,
    createdAt:      row.createdAt.toISOString(),
  }
}

export async function listeSeriennummern(
  db: Db,
  mandantId: string,
  opts: { artikelId?: string; status?: 'verfuegbar' | 'verkauft' } = {},
): Promise<Seriennummer[]> {
  const conds = [eq(seriennummern.mandantId, mandantId)]
  if (opts.artikelId) conds.push(eq(seriennummern.artikelId, opts.artikelId))
  if (opts.status)    conds.push(eq(seriennummern.status, opts.status))
  const rows = await db.select().from(seriennummern).where(and(...conds)).orderBy(seriennummern.seriennummer)
  return rows.map(toDto)
}

export async function erfasseSeriennummern(
  db: Db,
  mandantId: string,
  input: SeriennummernErfassenInput,
): Promise<Seriennummer[]> {
  const [a] = await db
    .select({ id: artikel.id, seriennummernAktiv: artikel.seriennummernAktiv })
    .from(artikel)
    .where(and(eq(artikel.id, input.artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!a) throw new SeriennummerError(404, 'Artikel nicht gefunden')
  if (!a.seriennummernAktiv) throw new SeriennummerError(400, 'Für diesen Artikel ist die Seriennummern-Verwaltung nicht aktiv')

  const unique = [...new Set(input.seriennummern.map(s => s.trim()).filter(Boolean))]
  if (unique.length === 0) throw new SeriennummerError(400, 'Keine Seriennummern angegeben')

  // Bereits vorhandene (pro Artikel eindeutige) Seriennummern werden übersprungen
  await db
    .insert(seriennummern)
    .values(unique.map(sn => ({ mandantId, artikelId: input.artikelId, seriennummer: sn, status: 'verfuegbar' as const })))
    .onConflictDoNothing()

  return listeSeriennummern(db, mandantId, { artikelId: input.artikelId })
}

export async function loescheSeriennummer(db: Db, mandantId: string, id: string): Promise<void> {
  const [row] = await db
    .select({ status: seriennummern.status })
    .from(seriennummern)
    .where(and(eq(seriennummern.id, id), eq(seriennummern.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new SeriennummerError(404, 'Seriennummer nicht gefunden')
  if (row.status !== 'verfuegbar') throw new SeriennummerError(409, 'Verkaufte Seriennummer kann nicht gelöscht werden')
  await db.delete(seriennummern).where(eq(seriennummern.id, id))
}
