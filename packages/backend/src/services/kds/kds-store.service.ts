/**
 * KDS-Store-Service
 * Speichert und verwaltet aktive Bonierbons für das Browser-KDS.
 */

import { eq, and, desc, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client.js'
import { kdsBons, bonierdrucker, type KdsPosition } from '../../db/schema.js'
import { emitKdsEvent } from '../../sse/kds-event-bus.js'
import { druckeBonierbon } from '../bonierdrucker.service.js'
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
  /** SB-Terminal-Bestellung: steuert Badge am KDS + Auto-„bereit" bei erledigt */
  sbBestellungId?:  string
  sbBestellNummer?: string
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
    sbBestellungId:  eingabe.sbBestellungId ?? null,
    sbBestellNummer: eingabe.sbBestellNummer ?? null,
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
      ...(bon.sbBestellNummer ? { sbBestellNummer: bon.sbBestellNummer } : {}),
    },
  })
}

/** Übersicht: Anzahl offener Bons pro Station (für Dashboard) */
export async function kdsUebersicht(db: Db, mandantId: string): Promise<{ total: number; perStation: Record<string, number> }> {
  const rows = await db
    .select({
      station: kdsBons.station,
      anzahl:  sql<number>`count(*)::int`,
    })
    .from(kdsBons)
    .where(and(
      eq(kdsBons.mandantId, mandantId),
      eq(kdsBons.status, 'offen'),
    ))
    .groupBy(kdsBons.station)

  const perStation: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    perStation[row.station] = row.anzahl
    total += row.anzahl
  }
  return { total, perStation }
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
    ...(b.sbBestellNummer ? { sbBestellNummer: b.sbBestellNummer } : {}),
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

/** Teilbon — ausgewählte Positionen (mit Teilmenge) als (teil-)erledigt markieren */
export async function kdsBonTeilbon(
  db:         Db,
  bonId:      string,
  mandantId:  string,
  posMengen:  { id: string; menge: number }[],
): Promise<{ bon: typeof kdsBons.$inferSelect } | null> {
  const [bon] = await db
    .select()
    .from(kdsBons)
    .where(and(eq(kdsBons.id, bonId), eq(kdsBons.mandantId, mandantId)))
    .limit(1)

  if (!bon || bon.status !== 'offen') return null

  // Doppelte positionIds summieren statt stillschweigend überschreiben
  const mengenMap = new Map<string, number>()
  for (const { id, menge } of posMengen) {
    mengenMap.set(id, (mengenMap.get(id) ?? 0) + menge)
  }

  const aktualisiert: KdsPosition[] = bon.positionen.map(p => {
    const zuSenden = mengenMap.get(p.id)
    if (!zuSenden) return p
    // erledigtMenge auf maximal menge begrenzen
    const neueErledigtMenge = Math.min((p.erledigtMenge ?? 0) + zuSenden, p.menge)
    const vollstaendig = neueErledigtMenge >= p.menge
    return {
      ...p,
      erledigtMenge: neueErledigtMenge,
      erledigt: vollstaendig,
    }
  })

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
  for (const { id: posId } of posMengen) {
    const pos = aktualisiert.find(p => p.id === posId)
    if (!pos) continue
    emitKdsEvent(mandantId, bon.station, {
      typ:        'position_toggle',
      bonId:      bon.id,
      positionId: posId,
      erledigt:   pos.erledigt,
      ...(pos.erledigtMenge !== undefined ? { erledigtMenge: pos.erledigtMenge } : {}),
    })
  }

  if (alleErledigt) {
    emitKdsEvent(mandantId, bon.station, { typ: 'bon_erledigt', bonId: bon.id })
  }

  return { bon: updated }
}

/** Archiv: erledigte Bons einer Station (neueste zuerst, paginiert) */
export async function kdsArchivBons(
  db:        Db,
  mandantId: string,
  station:   string | null,
  limit:     number,
  offset:    number,
) {
  const where = station
    ? and(eq(kdsBons.mandantId, mandantId), eq(kdsBons.status, 'erledigt'), eq(kdsBons.station, station))
    : and(eq(kdsBons.mandantId, mandantId), eq(kdsBons.status, 'erledigt'))

  const rows = await db
    .select()
    .from(kdsBons)
    .where(where)
    .orderBy(desc(kdsBons.erstelltAt))
    .limit(limit)
    .offset(offset)

  return rows.map(b => ({
    id:         b.id,
    bonNummer:  b.bonNummer,
    station:    b.station,
    tisch:      b.tisch,
    ...(b.bereich ? { bereich: b.bereich } : {}),
    kellner:    b.kellner,
    positionen: b.positionen,
    status:     b.status,
    erstelltAt: b.erstelltAt.toISOString(),
  }))
}

/** Nachdrucken: KDS-Bon an alle aktiven (nicht-Backup) Bonierdrucker senden */
export async function kdsBonNachdrucken(
  db:        Db,
  bonId:     string,
  mandantId: string,
): Promise<{ gedruckt: number; fehler: number }> {
  const [bon] = await db
    .select()
    .from(kdsBons)
    .where(and(eq(kdsBons.id, bonId), eq(kdsBons.mandantId, mandantId)))
    .limit(1)

  if (!bon) return { gedruckt: 0, fehler: 0 }

  const drucker = await db
    .select()
    .from(bonierdrucker)
    .where(and(
      eq(bonierdrucker.mandantId, mandantId),
      eq(bonierdrucker.aktiv, true),
      eq(bonierdrucker.istBackup, false),
    ))

  const zeilen = bon.positionen.map(p => ({
    menge:       p.menge,
    bezeichnung: p.bezeichnung,
    preisLabel:  '',
  }))

  let gedruckt = 0
  let fehler   = 0
  for (const d of drucker) {
    try {
      await druckeBonierbon(db, d.id, mandantId, bon.tisch, bon.kellner, zeilen)
      gedruckt++
    } catch {
      fehler++
    }
  }
  return { gedruckt, fehler }
}
