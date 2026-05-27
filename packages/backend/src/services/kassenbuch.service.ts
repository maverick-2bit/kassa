/**
 * Kassenbuch-Service: Bar-Einlagen und -Entnahmen.
 * Einträge sind unveränderlich (Kassenbuch-Prinzip).
 */

import { and, asc, between, eq, sql } from 'drizzle-orm'
import type { KassenbuchBuchung, KassenbuchResponse } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassenbuchBuchungen, users } from '../db/schema.js'

function toDto(
  row: typeof kassenbuchBuchungen.$inferSelect,
  userName: string | null = null,
): KassenbuchBuchung {
  return {
    id:         row.id,
    kasseId:    row.kasseId,
    typ:        row.typ as KassenbuchBuchung['typ'],
    betragCent: row.betragCent,
    grund:      row.grund,
    userId:     row.userId,
    userName,
    datum:      row.datum,
    createdAt:  row.createdAt.toISOString(),
  }
}

export async function erstelleKassenbuchBuchung(
  db:        Db,
  kasseId:   string,
  userId:    string,
  typ:       'einlage' | 'entnahme',
  betragCent: number,
  grund:     string | null | undefined,
  datum:     string,
): Promise<KassenbuchBuchung> {
  const [row] = await db
    .insert(kassenbuchBuchungen)
    .values({ kasseId, typ, betragCent, grund: grund ?? null, userId, datum })
    .returning()
  if (!row) throw new Error('Buchung konnte nicht angelegt werden')

  // User-Name nachladen
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  return toDto(row, user?.name ?? null)
}

export async function listeKassenbuchBuchungen(
  db:      Db,
  kasseId: string,
  von:     string,
  bis:     string,
): Promise<KassenbuchResponse> {
  // Join mit users für Namen
  const rows = await db
    .select({
      b:        kassenbuchBuchungen,
      userName: users.name,
    })
    .from(kassenbuchBuchungen)
    .leftJoin(users, eq(users.id, kassenbuchBuchungen.userId))
    .where(
      and(
        eq(kassenbuchBuchungen.kasseId, kasseId),
        between(kassenbuchBuchungen.datum, von, bis),
      ),
    )
    .orderBy(asc(kassenbuchBuchungen.datum), asc(kassenbuchBuchungen.createdAt))

  const buchungen = rows.map(r => toDto(r.b, r.userName ?? null))

  const einlagenCent  = buchungen.filter(b => b.typ === 'einlage') .reduce((s, b) => s + b.betragCent, 0)
  const entnahmenCent = buchungen.filter(b => b.typ === 'entnahme').reduce((s, b) => s + b.betragCent, 0)

  return {
    buchungen,
    einlagenCent,
    entnahmenCent,
    saldoCent: einlagenCent - entnahmenCent,
    von,
    bis,
  }
}
