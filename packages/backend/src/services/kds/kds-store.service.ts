/**
 * KDS-Store-Service
 * Speichert und verwaltet aktive Bonierbons für das Browser-KDS.
 */

import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client.js'
import { kdsBons, type KdsPosition } from '../../db/schema.js'
import { emitKdsEvent } from '../../sse/kds-event-bus.js'
import type { Station } from '@kassa/shared'

export interface NeueBonEingabe {
  mandantId:  string
  bonNummer:  string
  station:    Station
  tisch:      string
  bereich?:   string
  kellner:    string
  positionen: Array<{
    bezeichnung: string
    menge:       number
    details?:    string
  }>
}

/** Neuen KDS-Bon anlegen (wird beim Bonieren aufgerufen) */
export async function kdsBonErstellen(db: Db, eingabe: NeueBonEingabe): Promise<void> {
  const positionen: KdsPosition[] = eingabe.positionen.map(p => ({
    id:          randomUUID(),
    bezeichnung: p.bezeichnung,
    menge:       p.menge,
    ...(p.details ? { details: p.details } : {}),
    erledigt:    false,
  }))

  const [bon] = await db.insert(kdsBons).values({
    mandantId: eingabe.mandantId,
    bonNummer: eingabe.bonNummer,
    station:   eingabe.station,
    tisch:     eingabe.tisch,
    bereich:   eingabe.bereich ?? null,
    kellner:   eingabe.kellner,
    positionen,
  }).returning()

  if (!bon) return

  // SSE-Push an das Display dieser Station
  emitKdsEvent(eingabe.mandantId, eingabe.station, {
    typ: 'neuer_bon',
    bon: {
      id:         bon.id,
      bonNummer:  bon.bonNummer,
      station:    bon.station as Station,
      tisch:      bon.tisch,
      ...(bon.bereich ? { bereich: bon.bereich } : {}),
      kellner:    bon.kellner,
      positionen: bon.positionen,
      erstelltAt: bon.erstelltAt.toISOString(),
    },
  })
}

/** Übersicht: Anzahl offener Bons pro Station (für Dashboard) */
export async function kdsUebersicht(db: Db, mandantId: string): Promise<{ total: number; perStation: Record<string, number> }> {
  const rows = await db
    .select()
    .from(kdsBons)
    .where(and(
      eq(kdsBons.mandantId, mandantId),
      eq(kdsBons.status, 'offen'),
    ))

  const perStation: Record<string, number> = {}
  for (const row of rows) {
    perStation[row.station] = (perStation[row.station] ?? 0) + 1
  }
  return { total: rows.length, perStation }
}

/** Alle offenen Bons einer Station laden */
export async function kdsOffeneBons(db: Db, mandantId: string, station: string) {
  const rows = await db
    .select()
    .from(kdsBons)
    .where(and(
      eq(kdsBons.mandantId, mandantId),
      eq(kdsBons.station, station),
      eq(kdsBons.status, 'offen'),
    ))
    .orderBy(kdsBons.erstelltAt)

  return rows.map(b => ({
    id:         b.id,
    bonNummer:  b.bonNummer,
    station:    b.station,
    tisch:      b.tisch,
    bereich:    b.bereich ?? undefined,
    kellner:    b.kellner,
    positionen: b.positionen,
    erstelltAt: b.erstelltAt.toISOString(),
  }))
}

/** Bon als vollständig erledigt markieren */
export async function kdsBonErledigt(db: Db, bonId: string, mandantId: string): Promise<boolean> {
  const [bon] = await db
    .select()
    .from(kdsBons)
    .where(and(eq(kdsBons.id, bonId), eq(kdsBons.mandantId, mandantId)))
    .limit(1)

  if (!bon || bon.status !== 'offen') return false

  await db
    .update(kdsBons)
    .set({ status: 'erledigt' })
    .where(eq(kdsBons.id, bonId))

  // Push an alle Displays dieser Station
  emitKdsEvent(mandantId, bon.station, {
    typ:   'bon_erledigt',
    bonId: bon.id,
  })

  return true
}

/** Teilbon — ausgewählte Positionen als erledigt markieren */
export async function kdsBonTeilbon(
  db:          Db,
  bonId:       string,
  mandantId:   string,
  positionIds: string[],
): Promise<{ bon: typeof kdsBons.$inferSelect } | null> {
  const [bon] = await db
    .select()
    .from(kdsBons)
    .where(and(eq(kdsBons.id, bonId), eq(kdsBons.mandantId, mandantId)))
    .limit(1)

  if (!bon || bon.status !== 'offen') return null

  const idSet      = new Set(positionIds)
  const aktualisiert: KdsPosition[] = bon.positionen.map(p =>
    idSet.has(p.id) ? { ...p, erledigt: true } : p
  )

  // Wenn alle erledigt → Bon schließen
  const alleErledigt = aktualisiert.every(p => p.erledigt)

  const [updated] = await db
    .update(kdsBons)
    .set({
      positionen: aktualisiert,
      status:     alleErledigt ? 'erledigt' : 'offen',
    })
    .where(eq(kdsBons.id, bonId))
    .returning()

  if (!updated) return null

  // Push für jede geänderte Position
  for (const posId of positionIds) {
    emitKdsEvent(mandantId, bon.station, {
      typ:        'position_toggle',
      bonId:      bon.id,
      positionId: posId,
      erledigt:   true,
    })
  }

  if (alleErledigt) {
    emitKdsEvent(mandantId, bon.station, { typ: 'bon_erledigt', bonId: bon.id })
  }

  return { bon: updated }
}
