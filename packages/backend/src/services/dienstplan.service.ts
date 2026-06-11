import { and, between, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { dienstplanSchichten, users } from '../db/schema.js'
import type { DienstplanSchichtInput, DienstplanSchichtUpdate, DienstplanStatus } from '@kassa/shared'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

function minutenZwischen(von: string, bis: string): number {
  const [vh, vm] = von.split(':').map(Number)
  const [bh, bm] = bis.split(':').map(Number)
  const diff = (bh! * 60 + bm!) - (vh! * 60 + vm!)
  // Schichten über Mitternacht (z.B. 22:00–06:00) laufen in den nächsten Tag
  return diff < 0 ? diff + 24 * 60 : diff
}

function toDto(row: typeof dienstplanSchichten.$inferSelect) {
  return {
    id:            row.id,
    mandantId:     row.mandantId,
    kasseId:       row.kasseId,
    userId:        row.userId,
    userName:      row.userName,
    datum:         row.datum,
    beginnGeplant: row.beginnGeplant,
    endeGeplant:   row.endeGeplant,
    position:      row.position,
    notiz:         row.notiz,
    status:        row.status as DienstplanStatus,
    dauerMinuten:  minutenZwischen(row.beginnGeplant, row.endeGeplant),
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  }
}

export async function listeSchichten(
  db:        Db,
  mandantId: string,
  opts: { kasseId?: string; datumVon?: string; datumBis?: string; userId?: string; limit?: number } = {},
) {
  const conditions = [eq(dienstplanSchichten.mandantId, mandantId)]
  if (opts.kasseId)   conditions.push(eq(dienstplanSchichten.kasseId, opts.kasseId))
  if (opts.userId)    conditions.push(eq(dienstplanSchichten.userId,  opts.userId))
  if (opts.datumVon && opts.datumBis) {
    conditions.push(between(dienstplanSchichten.datum, opts.datumVon, opts.datumBis))
  } else if (opts.datumVon) {
    conditions.push(gte(dienstplanSchichten.datum, opts.datumVon))
  } else if (opts.datumBis) {
    conditions.push(lte(dienstplanSchichten.datum, opts.datumBis))
  }

  const rows = await db
    .select()
    .from(dienstplanSchichten)
    .where(and(...conditions))
    .orderBy(dienstplanSchichten.datum, dienstplanSchichten.beginnGeplant)
    .limit(opts.limit ?? 500)

  return rows.map(toDto)
}

export async function erstelleSchicht(
  db:        Db,
  mandantId: string,
  input:     DienstplanSchichtInput,
) {
  const ok = await pruefeKasseGehoertZuMandant(db, input.kasseId, mandantId)
  if (!ok) throw new Error('Kasse nicht gefunden')

  const [user] = await db
    .select({ name: users.name, aktiv: users.aktiv })
    .from(users)
    .where(and(eq(users.id, input.userId), eq(users.mandantId, mandantId)))
    .limit(1)

  if (!user) throw new Error('Benutzer nicht gefunden')
  if (!user.aktiv) throw new Error('Benutzer ist deaktiviert')

  const [row] = await db
    .insert(dienstplanSchichten)
    .values({
      mandantId,
      kasseId:       input.kasseId,
      userId:        input.userId,
      userName:      user.name,
      datum:         input.datum,
      beginnGeplant: input.beginnGeplant,
      endeGeplant:   input.endeGeplant,
      ...(input.position !== undefined && { position: input.position }),
      ...(input.notiz    !== undefined && { notiz:    input.notiz    }),
    })
    .returning()

  return toDto(row!)
}

export async function aktualisiereSchicht(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     DienstplanSchichtUpdate,
) {
  const changes: Partial<typeof dienstplanSchichten.$inferInsert> = { updatedAt: new Date() }
  if (input.datum         !== undefined) changes.datum         = input.datum
  if (input.beginnGeplant !== undefined) changes.beginnGeplant = input.beginnGeplant
  if (input.endeGeplant   !== undefined) changes.endeGeplant   = input.endeGeplant
  if (input.position      !== undefined) changes.position      = input.position
  if (input.notiz         !== undefined) changes.notiz         = input.notiz
  if (input.status        !== undefined) changes.status        = input.status

  const [row] = await db
    .update(dienstplanSchichten)
    .set(changes)
    .where(and(eq(dienstplanSchichten.id, id), eq(dienstplanSchichten.mandantId, mandantId)))
    .returning()

  if (!row) throw new Error('Schicht nicht gefunden')
  return toDto(row)
}

export async function loescheSchicht(db: Db, id: string, mandantId: string) {
  const [row] = await db
    .delete(dienstplanSchichten)
    .where(and(eq(dienstplanSchichten.id, id), eq(dienstplanSchichten.mandantId, mandantId)))
    .returning({ id: dienstplanSchichten.id })

  if (!row) throw new Error('Schicht nicht gefunden')
}
