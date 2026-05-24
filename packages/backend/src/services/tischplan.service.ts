import { eq, and } from 'drizzle-orm'
import type {
  TischplanBereich,
  TischplanBereichErstellen,
  TischplanBereichAktualisieren,
  TischplanElementErstellen,
  TischplanElementAktualisieren,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { tischplanBereiche, tischplanElemente } from '../db/schema.js'

export class TischplanError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface TischplanServiceDeps { db: Db }

// ---------------------------------------------------------------------------
// Bereiche
// ---------------------------------------------------------------------------

export async function listeBereiche(
  kasseId:   string,
  mandantId: string,
  deps:      TischplanServiceDeps,
): Promise<TischplanBereich[]> {
  const bereiche = await deps.db
    .select()
    .from(tischplanBereiche)
    .where(and(
      eq(tischplanBereiche.kasseId,   kasseId),
      eq(tischplanBereiche.mandantId, mandantId),
    ))
    .orderBy(tischplanBereiche.reihenfolge, tischplanBereiche.createdAt)

  const elemente = await deps.db
    .select()
    .from(tischplanElemente)
    .where(and(
      eq(tischplanElemente.kasseId,   kasseId),
      eq(tischplanElemente.mandantId, mandantId),
    ))

  return bereiche.map((b) => ({
    id:          b.id,
    kasseId:     b.kasseId,
    name:        b.name,
    reihenfolge: b.reihenfolge,
    elemente:    elemente
      .filter((e) => e.bereichId === b.id)
      .map((e) => ({
        id:          e.id,
        bereichId:   e.bereichId,
        bezeichnung: e.bezeichnung,
        form:        e.form as 'rechteck' | 'rund',
        farbe:       e.farbe as TischplanBereich['elemente'][number]['farbe'],
        x:           e.x,
        y:           e.y,
        breite:      e.breite,
        hoehe:       e.hoehe,
      })),
  }))
}

export async function erstelleBereich(
  input:     TischplanBereichErstellen,
  mandantId: string,
  deps:      TischplanServiceDeps,
): Promise<TischplanBereich> {
  const rows = await deps.db
    .insert(tischplanBereiche)
    .values({ kasseId: input.kasseId, mandantId, name: input.name, reihenfolge: 0 })
    .returning()
  const bereich = rows[0]!

  return { id: bereich.id, kasseId: bereich.kasseId, name: bereich.name, reihenfolge: bereich.reihenfolge, elemente: [] }
}

export async function aktualisiereBereich(
  id:        string,
  mandantId: string,
  input:     TischplanBereichAktualisieren,
  deps:      TischplanServiceDeps,
): Promise<void> {
  const [existing] = await deps.db
    .select({ id: tischplanBereiche.id })
    .from(tischplanBereiche)
    .where(and(eq(tischplanBereiche.id, id), eq(tischplanBereiche.mandantId, mandantId)))
    .limit(1)

  if (!existing) throw new TischplanError(404, 'Bereich nicht gefunden')

  const patch = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  )
  await deps.db
    .update(tischplanBereiche)
    .set(patch)
    .where(eq(tischplanBereiche.id, id))
}

export async function loescheBereich(
  id:        string,
  mandantId: string,
  deps:      TischplanServiceDeps,
): Promise<void> {
  const [existing] = await deps.db
    .select({ id: tischplanBereiche.id })
    .from(tischplanBereiche)
    .where(and(eq(tischplanBereiche.id, id), eq(tischplanBereiche.mandantId, mandantId)))
    .limit(1)

  if (!existing) throw new TischplanError(404, 'Bereich nicht gefunden')

  await deps.db.delete(tischplanBereiche).where(eq(tischplanBereiche.id, id))
}

// ---------------------------------------------------------------------------
// Elemente
// ---------------------------------------------------------------------------

export async function erstelleElement(
  input:     TischplanElementErstellen,
  mandantId: string,
  deps:      TischplanServiceDeps,
): Promise<TischplanBereich['elemente'][number]> {
  // Bereich-Ownership prüfen
  const [bereich] = await deps.db
    .select({ id: tischplanBereiche.id })
    .from(tischplanBereiche)
    .where(and(eq(tischplanBereiche.id, input.bereichId), eq(tischplanBereiche.mandantId, mandantId)))
    .limit(1)

  if (!bereich) throw new TischplanError(404, 'Bereich nicht gefunden')

  const elRows = await deps.db
    .insert(tischplanElemente)
    .values({
      kasseId:     input.kasseId,
      mandantId,
      bereichId:   input.bereichId,
      bezeichnung: input.bezeichnung,
      form:        input.form,
      farbe:       input.farbe,
      x:           input.x,
      y:           input.y,
      breite:      input.breite,
      hoehe:       input.hoehe,
    })
    .returning()
  const el = elRows[0]!

  return {
    id: el.id, bereichId: el.bereichId, bezeichnung: el.bezeichnung,
    form:  el.form  as 'rechteck' | 'rund',
    farbe: el.farbe as TischplanBereich['elemente'][number]['farbe'],
    x: el.x, y: el.y, breite: el.breite, hoehe: el.hoehe,
  }
}

export async function aktualisiereElement(
  id:        string,
  mandantId: string,
  input:     TischplanElementAktualisieren,
  deps:      TischplanServiceDeps,
): Promise<void> {
  const [existing] = await deps.db
    .select({ id: tischplanElemente.id })
    .from(tischplanElemente)
    .where(and(eq(tischplanElemente.id, id), eq(tischplanElemente.mandantId, mandantId)))
    .limit(1)

  if (!existing) throw new TischplanError(404, 'Element nicht gefunden')

  const patch = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  )
  await deps.db
    .update(tischplanElemente)
    .set(patch)
    .where(eq(tischplanElemente.id, id))
}

export async function loescheElement(
  id:        string,
  mandantId: string,
  deps:      TischplanServiceDeps,
): Promise<void> {
  const [existing] = await deps.db
    .select({ id: tischplanElemente.id })
    .from(tischplanElemente)
    .where(and(eq(tischplanElemente.id, id), eq(tischplanElemente.mandantId, mandantId)))
    .limit(1)

  if (!existing) throw new TischplanError(404, 'Element nicht gefunden')

  await deps.db.delete(tischplanElemente).where(eq(tischplanElemente.id, id))
}
