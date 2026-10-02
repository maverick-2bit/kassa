/**
 * Kategorie-Service: CRUD für Artikel-Kategorien.
 * Soft-Delete via aktiv=false — Kategorien werden nie gelöscht,
 * bestehende Artikel behalten die Referenz.
 */

import { and, asc, eq } from 'drizzle-orm'
import { KATEGORIE_MAX_TIEFE, type Kategorie, type KategorieInput, type KategorieUpdate } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kategorien } from '../db/schema.js'

/** Fachfehler (4xx) — der globale Fehler-Handler beantwortet ihn mit { fehler }. */
export class KategorieError extends Error {
  constructor(message: string, readonly httpStatus: number = 400) {
    super(message)
    this.name = 'KategorieError'
  }
}

/**
 * Prüft eine neue Elterngruppe gegen den Baum des Mandanten (rein, ohne DB).
 * `knoten` = ALLE Kategorien des Mandanten (id + parentId). `selbstId` null =
 * Neuanlage. Wirft KategorieError bei fremder/unbekannter Gruppe, Zyklus oder
 * Überschreitung der Maximaltiefe (inkl. der Tiefe des mitverschobenen Teilbaums).
 */
export function pruefeKategorieParent(
  knoten: readonly { id: string; parentId: string | null }[],
  selbstId: string | null,
  parentId: string,
): void {
  const parentVon = new Map(knoten.map(k => [k.id, k.parentId] as const))
  if (!parentVon.has(parentId)) throw new KategorieError('Übergeordnete Gruppe nicht gefunden', 400)
  if (selbstId !== null && selbstId === parentId) {
    throw new KategorieError('Eine Gruppe kann nicht sich selbst untergeordnet sein', 400)
  }
  // Kette von der Elterngruppe bis zur Wurzel: Zyklus + Tiefe der Elterngruppe
  let tiefeParent = 0
  const besucht = new Set<string>()
  for (let cur: string | null | undefined = parentId; cur; cur = parentVon.get(cur)) {
    if (cur === selbstId) throw new KategorieError('Zyklus: die Gruppe läge unter ihrer eigenen Untergruppe', 400)
    if (besucht.has(cur)) break // bereits kaputter Altbestand — nicht endlos laufen
    besucht.add(cur)
    tiefeParent++
  }
  // Höhe des Teilbaums unter selbst (selbst zählt als 1)
  const kinder = new Map<string, string[]>()
  for (const k of knoten) if (k.parentId) kinder.set(k.parentId, [...(kinder.get(k.parentId) ?? []), k.id])
  const hoehe = (id: string, tiefeBis: number): number =>
    tiefeBis > KATEGORIE_MAX_TIEFE + 1 ? 0
      : 1 + Math.max(0, ...(kinder.get(id) ?? []).map(c => hoehe(c, tiefeBis + 1)))
  const hoeheSelbst = selbstId === null ? 1 : hoehe(selbstId, 1)
  if (tiefeParent + hoeheSelbst > KATEGORIE_MAX_TIEFE) {
    throw new KategorieError(`Warengruppen dürfen höchstens ${KATEGORIE_MAX_TIEFE} Ebenen tief verschachtelt sein`, 400)
  }
}

async function validiereParent(db: Db, mandantId: string, selbstId: string | null, parentId: string): Promise<void> {
  const knoten = await db
    .select({ id: kategorien.id, parentId: kategorien.parentId })
    .from(kategorien)
    .where(eq(kategorien.mandantId, mandantId))
  pruefeKategorieParent(knoten, selbstId, parentId)
}

function toDto(row: typeof kategorien.$inferSelect): Kategorie {
  return {
    id:              row.id,
    mandantId:       row.mandantId,
    name:            row.name,
    farbe:           row.farbe as Kategorie['farbe'],
    reihenfolge:     row.reihenfolge,
    aktiv:           row.aktiv,
    parentId:        row.parentId,
    bonierdruckerId: row.bonierdruckerId,
    station:         row.station as Kategorie['station'],
    terminalSichtbar: row.terminalSichtbar,
    createdAt:       row.createdAt.toISOString(),
    updatedAt:       row.updatedAt.toISOString(),
  }
}

export async function erstelleKategorie(
  db: Db,
  mandantId: string,
  input: KategorieInput,
): Promise<Kategorie> {
  if (input.parentId) await validiereParent(db, mandantId, null, input.parentId)
  const [created] = await db.insert(kategorien).values({
    mandantId,
    name:            input.name,
    farbe:           input.farbe,
    reihenfolge:     input.reihenfolge,
    parentId:        input.parentId ?? null,
    bonierdruckerId: input.bonierdruckerId ?? null,
    station:         input.station ?? null,
    terminalSichtbar: input.terminalSichtbar ?? false,
  }).returning()
  if (!created) throw new Error('Kategorie konnte nicht angelegt werden')
  return toDto(created)
}

export async function listeKategorien(
  db: Db,
  mandantId: string,
  opts: { nurAktive?: boolean } = {},
): Promise<Kategorie[]> {
  const conditions = opts.nurAktive
    ? and(eq(kategorien.mandantId, mandantId), eq(kategorien.aktiv, true))
    : eq(kategorien.mandantId, mandantId)

  const rows = await db
    .select()
    .from(kategorien)
    .where(conditions)
    .orderBy(asc(kategorien.reihenfolge), asc(kategorien.name))

  return rows.map(toDto)
}

/**
 * `mandantId` (aus dem JWT) wird nur für die Baum-Prüfung der Elterngruppe
 * gebraucht; die Zugehörigkeit von `id` selbst prüft die Route vorher.
 */
export async function aktualisiereKategorie(
  db: Db,
  id: string,
  update: KategorieUpdate,
  mandantId?: string,
): Promise<Kategorie | null> {
  if (update.parentId && mandantId) await validiereParent(db, mandantId, id, update.parentId)
  if (update.aktiv === false) {
    // Eine Gruppe mit aktiven Untergruppen würde diese unerreichbar machen
    const kinder = await db
      .select({ id: kategorien.id })
      .from(kategorien)
      .where(and(eq(kategorien.parentId, id), eq(kategorien.aktiv, true)))
      .limit(1)
    if (kinder.length > 0) {
      throw new KategorieError('Die Gruppe hat noch aktive Untergruppen — diese zuerst deaktivieren oder verschieben', 409)
    }
  }
  const values: Partial<typeof kategorien.$inferInsert> = { updatedAt: new Date() }
  if (update.name            !== undefined) values.name            = update.name
  if (update.farbe           !== undefined) values.farbe           = update.farbe
  if (update.reihenfolge     !== undefined) values.reihenfolge     = update.reihenfolge
  if (update.aktiv           !== undefined) values.aktiv           = update.aktiv
  if (update.parentId        !== undefined) values.parentId        = update.parentId
  if (update.bonierdruckerId !== undefined) values.bonierdruckerId = update.bonierdruckerId
  if (update.station         !== undefined) values.station         = update.station
  if (update.terminalSichtbar !== undefined) values.terminalSichtbar = update.terminalSichtbar

  const [updated] = await db
    .update(kategorien)
    .set(values)
    .where(eq(kategorien.id, id))
    .returning()

  return updated ? toDto(updated) : null
}

export async function deaktiviereKategorie(db: Db, id: string): Promise<Kategorie | null> {
  return aktualisiereKategorie(db, id, { aktiv: false })
}
