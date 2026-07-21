/**
 * Bestandteil-/Rezept-Service (Stückliste).
 *
 * Ein Verkaufsartikel kann aus Bestandteilen (Rohstoff-Artikeln) mit Menge
 * zusammengesetzt sein (Tabelle `artikel_bestandteile`). Beim Verkauf/Bonieren
 * wird der Lagerstand der Bestandteile abgebucht; erreicht ein Bestandteil 0,
 * gilt der Verkaufsartikel über die abgeleitete `verfuegbareMenge` als gesperrt.
 *
 * Dieser Helper kapselt Lesen (Rezepte laden), Schreiben (Rezept ersetzen),
 * Abbuchen (an den 3 Lager-Hooks gespiegelt) und die abgeleitete Verfügbarkeit.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { artikel, artikelBestandteile } from '../db/schema.js'

/** Db oder laufende Transaktion — beide teilen die Query-Builder-Oberfläche. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

/** Ein Bestandteil im Rezept (schlanke Form für die Abbuchung). */
export interface RezeptBestandteil {
  bestandteilArtikelId: string
  menge:                number
}

/** Ein Bestandteil angereichert (für DTO + abgeleitete Verfügbarkeit). */
export interface BestandteilAngereichert {
  bestandteilArtikelId: string
  bezeichnung:          string
  menge:                number
  lagerstandAktiv:      boolean
  lagerstandMenge:      number | null
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * Lädt die Rezepte (Bestandteile) der gegebenen Verkaufsartikel — schlanke Form.
 * Rückgabe: Map verkaufsartikelId → Bestandteile[].
 */
export async function ladeRezepte(
  db: DbOrTx,
  verkaufsartikelIds: string[],
): Promise<Map<string, RezeptBestandteil[]>> {
  const map = new Map<string, RezeptBestandteil[]>()
  if (verkaufsartikelIds.length === 0) return map
  const rows = await db
    .select({
      verkaufsartikelId:    artikelBestandteile.verkaufsartikelId,
      bestandteilArtikelId: artikelBestandteile.bestandteilArtikelId,
      menge:                artikelBestandteile.menge,
    })
    .from(artikelBestandteile)
    .where(inArray(artikelBestandteile.verkaufsartikelId, verkaufsartikelIds))
  for (const r of rows) {
    const list = map.get(r.verkaufsartikelId) ?? []
    list.push({ bestandteilArtikelId: r.bestandteilArtikelId, menge: r.menge })
    map.set(r.verkaufsartikelId, list)
  }
  return map
}

/**
 * Lädt die Rezepte angereichert um Bezeichnung + Lagerstand des Bestandteil-Artikels
 * (für DTO + abgeleitete Verfügbarkeit). Rückgabe: Map verkaufsartikelId → Bestandteile[].
 */
export async function ladeRezepteAngereichert(
  db: DbOrTx,
  verkaufsartikelIds: string[],
): Promise<Map<string, BestandteilAngereichert[]>> {
  const map = new Map<string, BestandteilAngereichert[]>()
  if (verkaufsartikelIds.length === 0) return map
  const rows = await db
    .select({
      verkaufsartikelId:    artikelBestandteile.verkaufsartikelId,
      bestandteilArtikelId: artikelBestandteile.bestandteilArtikelId,
      menge:                artikelBestandteile.menge,
      bezeichnung:          artikel.bezeichnung,
      lagerstandAktiv:      artikel.lagerstandAktiv,
      lagerstandMenge:      artikel.lagerstandMenge,
    })
    .from(artikelBestandteile)
    .innerJoin(artikel, eq(artikel.id, artikelBestandteile.bestandteilArtikelId))
    .where(inArray(artikelBestandteile.verkaufsartikelId, verkaufsartikelIds))
  for (const r of rows) {
    const list = map.get(r.verkaufsartikelId) ?? []
    list.push({
      bestandteilArtikelId: r.bestandteilArtikelId,
      bezeichnung:          r.bezeichnung,
      menge:                r.menge,
      lagerstandAktiv:      r.lagerstandAktiv,
      lagerstandMenge:      r.lagerstandMenge,
    })
    map.set(r.verkaufsartikelId, list)
  }
  return map
}

/**
 * Abgeleitete Verfügbarkeit eines Verkaufsartikels:
 * min über alle lagergeführten Bestandteile von floor(lagerstand / rezeptMenge).
 * Gibt null zurück, wenn kein lagergeführter Bestandteil existiert (kein Rezept-Limit).
 */
export function berechneVerfuegbareMenge(bestandteile: BestandteilAngereichert[]): number | null {
  let min: number | null = null
  for (const b of bestandteile) {
    if (!b.lagerstandAktiv || b.lagerstandMenge === null || b.menge <= 0) continue
    const moeglich = Math.floor(b.lagerstandMenge / b.menge)
    min = min === null ? moeglich : Math.min(min, moeglich)
  }
  return min
}

// ---------------------------------------------------------------------------
// Schreiben (Rezept ersetzen)
// ---------------------------------------------------------------------------

/**
 * Ersetzt das Rezept eines Verkaufsartikels: löscht bestehende Bestandteile und
 * schreibt die neuen. Filtert Selbstreferenz + nicht-positive Mengen, fasst
 * Duplikate (gleicher Bestandteil-Artikel) durch Summe zusammen und stellt sicher,
 * dass alle Bestandteil-Artikel zum selben Mandanten gehören.
 */
export async function schreibeRezept(
  tx: DbOrTx,
  verkaufsartikelId: string,
  mandantId: string,
  bestandteile: { bestandteilArtikelId: string; menge: number }[],
): Promise<void> {
  await tx.delete(artikelBestandteile).where(eq(artikelBestandteile.verkaufsartikelId, verkaufsartikelId))

  const summiert = new Map<string, number>()
  for (const b of bestandteile) {
    if (b.bestandteilArtikelId === verkaufsartikelId || b.menge <= 0) continue
    summiert.set(b.bestandteilArtikelId, (summiert.get(b.bestandteilArtikelId) ?? 0) + b.menge)
  }
  if (summiert.size === 0) return

  // Mandanten-Zugehörigkeit der Bestandteil-Artikel absichern
  const ids = [...summiert.keys()]
  const vorhandene = await tx
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(inArray(artikel.id, ids), eq(artikel.mandantId, mandantId)))
  if (vorhandene.length !== ids.length) {
    throw new Error('Mindestens ein Bestandteil-Artikel gehört nicht zum Mandanten')
  }

  await tx.insert(artikelBestandteile).values(
    [...summiert.entries()].map(([bestandteilArtikelId, menge]) => ({
      mandantId,
      verkaufsartikelId,
      bestandteilArtikelId,
      menge,
    })),
  )
}

// ---------------------------------------------------------------------------
// Abbuchen (an den 3 Lager-Hooks gespiegelt)
// ---------------------------------------------------------------------------

/**
 * Bucht den Bestandteil-Bedarf aus Verkaufs-Positionen (artikelId × menge) atomar
 * vom Lagerstand ab (GREATEST(0, …), nur lagerstandAktiv). Für Positive-Abbuchung
 * an den Direktverkauf-/Bonier-Hooks. Artikel ohne Rezept werden ignoriert.
 */
export async function dekrementiereBestandteile(
  tx: DbOrTx,
  positionen: { artikelId: string; menge: number }[],
  rezepte: Map<string, RezeptBestandteil[]>,
): Promise<void> {
  const bedarf = summiereBedarf(positionen.map(p => ({ artikelId: p.artikelId, delta: p.menge })), rezepte)
  for (const [bestandteilId, menge] of bedarf) {
    if (menge === 0) continue
    await tx
      .update(artikel)
      .set({
        lagerstandMenge: sql`GREATEST(0, COALESCE(${artikel.lagerstandMenge}, 0) - ${menge})`,
        updatedAt:       new Date(),
      })
      .where(and(eq(artikel.id, bestandteilId), eq(artikel.lagerstandAktiv, true)))
  }
}

/**
 * Wendet vorzeichenbehaftete Artikel-Deltas auf die Bestandteile an (Tisch-Fluss):
 * delta > 0 = Abzug (mehr bestellt), delta < 0 = Rückbuchung (storniert). Read-then-write
 * mit Math.max(0, …) — gespiegelt zur Artikel-Logik in aktualisiereStockDeltas.
 */
export async function wendeBestandteilDeltasAn(
  db: DbOrTx,
  artikelDeltas: { artikelId: string; delta: number }[],
  rezepte: Map<string, RezeptBestandteil[]>,
): Promise<void> {
  const bedarf = summiereBedarf(artikelDeltas, rezepte)
  if (bedarf.size === 0) return
  const ids = [...bedarf.keys()]
  const rows = await db
    .select({ id: artikel.id, lagerstandAktiv: artikel.lagerstandAktiv, lagerstandMenge: artikel.lagerstandMenge })
    .from(artikel)
    .where(inArray(artikel.id, ids))
  for (const row of rows) {
    if (!row.lagerstandAktiv || row.lagerstandMenge === null) continue
    const delta = bedarf.get(row.id) ?? 0
    if (delta === 0) continue
    const neueMenge = Math.max(0, row.lagerstandMenge - delta)
    await db.update(artikel)
      .set({ lagerstandMenge: neueMenge, updatedAt: new Date() })
      .where(eq(artikel.id, row.id))
  }
}

/** Summiert den Bestandteil-Bedarf (bestandteilArtikelId → Σ rezeptMenge × delta). */
function summiereBedarf(
  artikelDeltas: { artikelId: string; delta: number }[],
  rezepte: Map<string, RezeptBestandteil[]>,
): Map<string, number> {
  const bedarf = new Map<string, number>()
  for (const d of artikelDeltas) {
    const rezept = rezepte.get(d.artikelId)
    if (!rezept) continue
    for (const b of rezept) {
      bedarf.set(b.bestandteilArtikelId, (bedarf.get(b.bestandteilArtikelId) ?? 0) + b.menge * d.delta)
    }
  }
  return bedarf
}
