import { and, asc, eq } from 'drizzle-orm'
import type { Lieferant, LieferantInput, LieferantUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { lieferanten } from '../db/schema.js'

function toDto(row: typeof lieferanten.$inferSelect): Lieferant {
  return {
    id:        row.id,
    mandantId: row.mandantId,
    name:      row.name,
    kontakt:   row.kontakt,
    email:     row.email,
    telefon:   row.telefon,
    notiz:     row.notiz,
    aktiv:     row.aktiv,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listeLieferanten(db: Db, mandantId: string): Promise<Lieferant[]> {
  const rows = await db.select().from(lieferanten)
    .where(and(eq(lieferanten.mandantId, mandantId), eq(lieferanten.aktiv, true)))
    .orderBy(asc(lieferanten.name))
  return rows.map(toDto)
}

export async function erstelleLieferant(
  db: Db, mandantId: string, input: LieferantInput,
): Promise<Lieferant> {
  const [row] = await db.insert(lieferanten).values({
    mandantId,
    name:    input.name,
    kontakt: input.kontakt ?? null,
    email:   input.email   ?? null,
    telefon: input.telefon ?? null,
    notiz:   input.notiz   ?? null,
  }).returning()
  return toDto(row!)
}

export async function aktualisiereLieferant(
  db: Db, id: string, mandantId: string, input: LieferantUpdate,
): Promise<Lieferant | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name    !== undefined) updates['name']    = input.name
  if (input.kontakt !== undefined) updates['kontakt'] = input.kontakt
  if (input.email   !== undefined) updates['email']   = input.email
  if (input.telefon !== undefined) updates['telefon'] = input.telefon
  if (input.notiz   !== undefined) updates['notiz']   = input.notiz
  if (input.aktiv   !== undefined) updates['aktiv']   = input.aktiv

  const [row] = await db.update(lieferanten)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(updates as any)
    .where(and(eq(lieferanten.id, id), eq(lieferanten.mandantId, mandantId)))
    .returning()
  return row ? toDto(row) : null
}

export async function deaktiviereLieferant(
  db: Db, id: string, mandantId: string,
): Promise<boolean> {
  const result = await db.update(lieferanten)
    .set({ aktiv: false, updatedAt: new Date() })
    .where(and(eq(lieferanten.id, id), eq(lieferanten.mandantId, mandantId)))
    .returning({ id: lieferanten.id })
  return result.length > 0
}
