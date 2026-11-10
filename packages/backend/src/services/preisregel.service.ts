/**
 * Preisregel-Service (Happy Hour / zeitgesteuerte Aktionspreise) — mandant-scoped CRUD.
 * Die eigentliche Preisanwendung passiert im Frontend beim Kassieren/Bonieren
 * (aktionsPreisCent aus @kassa/shared); hier werden nur die Regeln verwaltet.
 */

import { eq } from 'drizzle-orm'
import { endeNachAktionstagen, preisregelFehler } from '@kassa/shared'
import type { Preisregel, PreisregelInput, PreisregelUpdate, Zeitfenster } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { preisregeln } from '../db/schema.js'

export class PreisregelError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

function toResponse(row: typeof preisregeln.$inferSelect): Preisregel {
  return {
    id:            row.id,
    name:          row.name,
    aktiv:         row.aktiv,
    wochentage:    (row.wochentage as number[]) ?? [],
    datumTage:     (row.datumTage as string[]) ?? [],
    zeitfenster:   (row.zeitfenster as Zeitfenster[]) ?? [],
    gueltigVon:    row.gueltigVon,
    gueltigBis:    row.gueltigBis,
    rabattProzent: row.rabattProzent,
    artikelPreise: (row.artikelPreise as { artikelId: string; preisCent: number }[]) ?? [],
    kategorieIds:  (row.kategorieIds as string[]) ?? [],
    artikelIds:    (row.artikelIds as string[]) ?? [],
    mengeKauf:     row.mengeKauf,
    mengeZahle:    row.mengeZahle,
    mengeModus:    (row.mengeModus as 'artikel' | 'auswahl' | null) ?? null,
    wiederholungen: row.wiederholungen,
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  }
}

export async function listePreisregeln(db: Db, mandantId: string): Promise<Preisregel[]> {
  const rows = await db
    .select()
    .from(preisregeln)
    .where(eq(preisregeln.mandantId, mandantId))
    .orderBy(preisregeln.createdAt)
  return rows.map(toResponse)
}

/** „nach X Aktionstagen" → gueltigBis berechnen (die Prüfung „gilt jetzt" kennt nur Daten) */
function mitBerechnetemEnde<T extends { wochentage: number[]; gueltigVon: string | null; gueltigBis: string | null; wiederholungen: number | null }>(d: T): T {
  if (d.wiederholungen === null || !d.gueltigVon) return d
  const ende = endeNachAktionstagen(d.gueltigVon, d.wochentage, d.wiederholungen)
  if (!ende) throw new PreisregelError(400, 'Das Enddatum lässt sich aus den Wiederholungen nicht berechnen')
  return { ...d, gueltigBis: ende }
}

export async function erstellePreisregel(db: Db, mandantId: string, rohInput: PreisregelInput): Promise<Preisregel> {
  const input = mitBerechnetemEnde(rohInput)
  const [row] = await db
    .insert(preisregeln)
    .values({
      mandantId,
      name:          input.name,
      aktiv:         input.aktiv,
      wochentage:    input.wochentage,
      datumTage:     input.datumTage,
      zeitfenster:   input.zeitfenster,
      gueltigVon:    input.gueltigVon,
      gueltigBis:    input.gueltigBis,
      rabattProzent: input.rabattProzent,
      artikelPreise: input.artikelPreise,
      kategorieIds:  input.kategorieIds,
      artikelIds:    input.artikelIds,
      mengeKauf:     input.mengeKauf,
      mengeZahle:    input.mengeZahle,
      mengeModus:    input.mengeModus,
      wiederholungen: input.wiederholungen,
    })
    .returning()
  if (!row) throw new Error('Preisregel konnte nicht angelegt werden')
  return toResponse(row)
}

export async function aktualisierePreisregel(
  db: Db,
  id: string,
  input: PreisregelUpdate,
): Promise<Preisregel | null> {
  // Änderungen mit dem Bestand zusammenführen und als Ganzes fachlich prüfen (Teil-Updates dürfen keine
  // unzulässige Kombination erzeugen, z. B. Prozent-Rabatt auf eine Mengenaktion)
  const [vorher] = await db.select().from(preisregeln).where(eq(preisregeln.id, id)).limit(1)
  if (!vorher) return null
  const alt = toResponse(vorher)
  const zusammen = mitBerechnetemEnde({
    wochentage:    input.wochentage    ?? alt.wochentage,
    datumTage:     input.datumTage     ?? alt.datumTage,
    rabattProzent: input.rabattProzent ?? alt.rabattProzent,
    artikelPreise: input.artikelPreise ?? alt.artikelPreise,
    mengeKauf:     input.mengeKauf     !== undefined ? input.mengeKauf     : alt.mengeKauf,
    mengeZahle:    input.mengeZahle    !== undefined ? input.mengeZahle    : alt.mengeZahle,
    mengeModus:    input.mengeModus    !== undefined ? input.mengeModus    : alt.mengeModus,
    wiederholungen: input.wiederholungen !== undefined ? input.wiederholungen : alt.wiederholungen,
    gueltigVon:    input.gueltigVon    !== undefined ? input.gueltigVon    : alt.gueltigVon,
    gueltigBis:    input.gueltigBis    !== undefined ? input.gueltigBis    : alt.gueltigBis,
  })
  const fehler = preisregelFehler(zusammen)
  if (fehler) throw new PreisregelError(400, fehler)

  const updates: Partial<typeof preisregeln.$inferInsert> = { updatedAt: new Date() }
  if (input.name          !== undefined) updates.name          = input.name
  if (input.aktiv         !== undefined) updates.aktiv         = input.aktiv
  if (input.wochentage    !== undefined) updates.wochentage    = input.wochentage
  if (input.datumTage     !== undefined) updates.datumTage     = input.datumTage
  if (input.zeitfenster   !== undefined) updates.zeitfenster   = input.zeitfenster
  if (input.gueltigVon    !== undefined) updates.gueltigVon    = input.gueltigVon
  // Enddatum: bei „nach X Aktionstagen" immer das berechnete, sonst das gesendete
  if (input.gueltigBis    !== undefined || input.wiederholungen !== undefined || input.gueltigVon !== undefined || input.wochentage !== undefined) {
    updates.gueltigBis = zusammen.gueltigBis
  }
  if (input.mengeKauf     !== undefined) updates.mengeKauf     = input.mengeKauf
  if (input.mengeZahle    !== undefined) updates.mengeZahle    = input.mengeZahle
  if (input.mengeModus    !== undefined) updates.mengeModus    = input.mengeModus
  if (input.wiederholungen !== undefined) updates.wiederholungen = input.wiederholungen
  if (input.rabattProzent !== undefined) updates.rabattProzent = input.rabattProzent
  if (input.artikelPreise !== undefined) updates.artikelPreise = input.artikelPreise
  if (input.kategorieIds  !== undefined) updates.kategorieIds  = input.kategorieIds
  if (input.artikelIds    !== undefined) updates.artikelIds    = input.artikelIds

  const [row] = await db.update(preisregeln).set(updates).where(eq(preisregeln.id, id)).returning()
  return row ? toResponse(row) : null
}

export async function loeschePreisregel(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .delete(preisregeln)
    .where(eq(preisregeln.id, id))
    .returning({ id: preisregeln.id })
  return !!row
}
