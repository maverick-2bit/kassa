/**
 * Artikel-Anordnung je Kasse + Warengruppe (Kachel-Raster) und Standard-Raster einer Warengruppe.
 *
 * Kassen-Anordnung (Tabelle kasse_artikel_layout): Existiert für (Kasse, Warengruppe) mindestens
 * eine Zeile, gilt sie — Semantik und Auflösung in @kassa/shared (raster.ts). Der Server speichert
 * und liefert nur die Zeilen:
 *  - Schreiben ERSETZT alle Zeilen der Kasse + Warengruppe in einer Transaktion (gleichzeitige
 *    Speichervorgänge derselben Gruppe laufen hintereinander: Advisory-Lock).
 *  - Lesen liefert nur Zeilen, deren Artikel (noch) in der Warengruppe liegt und zum Mandanten
 *    gehört. Die Oberfläche schickt geladene Listen beim Speichern komplett zurück — eine veraltete
 *    Zeile (Artikel inzwischen verschoben) würde sonst jedes Speichern abweisen.
 *
 * Standard-Raster (artikel.raster_position + reihenfolge): wie der Layout-Import setzt das Speichern
 * `reihenfolge` = Slot, damit alle Oberflächen (auch die Kellner-App, die nach reihenfolge sortiert)
 * dieselbe Reihenfolge zeigen.
 *
 * Mandant, Kasse, Warengruppe und Artikel werden jeweils gegen den Mandanten aus dem JWT geprüft;
 * Fremdes ist „nicht gefunden" (404), Artikel einer anderen Warengruppe des eigenen Mandanten 400.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { KasseArtikelLayout, KasseArtikelLayoutEintrag, StandardRasterEintrag } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, kasseArtikelLayout, kassen, kategorien } from '../db/schema.js'

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export class KassenLayoutError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
    this.name = 'KassenLayoutError'
  }
}

async function pruefeKasse(tx: Tx, mandantId: string, kasseId: string): Promise<void> {
  const [row] = await tx.select({ id: kassen.id }).from(kassen)
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new KassenLayoutError(404, 'Kasse nicht gefunden')
}

async function pruefeGruppe(tx: Tx, mandantId: string, kategorieId: string): Promise<void> {
  const [row] = await tx.select({ id: kategorien.id }).from(kategorien)
    .where(and(eq(kategorien.id, kategorieId), eq(kategorien.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new KassenLayoutError(404, 'Warengruppe nicht gefunden')
}

/** Alle Artikel gehören zum Mandanten (sonst 404) UND liegen in der Warengruppe (sonst 400). */
async function pruefeArtikel(tx: Tx, mandantId: string, kategorieId: string, artikelIds: readonly string[]): Promise<void> {
  const ids = [...new Set(artikelIds)]
  if (ids.length === 0) return
  const rows = await tx.select({ id: artikel.id, kategorieId: artikel.kategorieId }).from(artikel)
    .where(and(inArray(artikel.id, ids), eq(artikel.mandantId, mandantId)))
  if (rows.length !== ids.length) throw new KassenLayoutError(404, 'Artikel nicht gefunden')
  if (rows.some(r => r.kategorieId !== kategorieId)) {
    throw new KassenLayoutError(400, 'Artikel gehört nicht zu dieser Warengruppe')
  }
}

/** Gleichzeitige Schreibvorgänge auf dieselbe Kasse + Warengruppe laufen hintereinander. */
async function sperre(tx: Tx, schluessel: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${schluessel}))`)
}

// ---------------------------------------------------------------------------
// Kassen-Anordnung
// ---------------------------------------------------------------------------

/**
 * Alle Anordnungen einer Kasse, je Warengruppe die Einträge (platziert nach Position, dann
 * ausgeblendete). Nur Zeilen mit Artikel in genau dieser Warengruppe, alles im Mandanten.
 * Die Kasse selbst prüft der Aufrufer (404).
 */
export async function ladeKassenLayouts(db: Tx, mandantId: string, kasseId: string): Promise<KasseArtikelLayout[]> {
  const rows = await db
    .select({
      kategorieId:  kasseArtikelLayout.kategorieId,
      artikelId:    kasseArtikelLayout.artikelId,
      position:     kasseArtikelLayout.position,
      ausgeblendet: kasseArtikelLayout.ausgeblendet,
    })
    .from(kasseArtikelLayout)
    .innerJoin(kassen, eq(kassen.id, kasseArtikelLayout.kasseId))
    .innerJoin(kategorien, eq(kategorien.id, kasseArtikelLayout.kategorieId))
    .innerJoin(artikel, and(
      eq(artikel.id, kasseArtikelLayout.artikelId),
      // Artikel in eine andere Warengruppe verschoben → die Zeile gilt nicht mehr
      eq(artikel.kategorieId, kasseArtikelLayout.kategorieId),
    ))
    .where(and(
      eq(kasseArtikelLayout.kasseId, kasseId),
      eq(kasseArtikelLayout.mandantId, mandantId),
      eq(kassen.mandantId, mandantId),
      eq(kategorien.mandantId, mandantId),
      eq(artikel.mandantId, mandantId),
    ))
    // Position aufsteigend: NULL (ausgeblendet) steht bei ASC zuletzt
    .orderBy(asc(kasseArtikelLayout.kategorieId), asc(kasseArtikelLayout.position), asc(kasseArtikelLayout.artikelId))

  const jeGruppe = new Map<string, KasseArtikelLayoutEintrag[]>()
  for (const r of rows) {
    const liste = jeGruppe.get(r.kategorieId) ?? []
    liste.push({ artikelId: r.artikelId, position: r.position, ausgeblendet: r.ausgeblendet })
    jeGruppe.set(r.kategorieId, liste)
  }
  return [...jeGruppe].map(([kategorieId, eintraege]) => ({ kategorieId, eintraege }))
}

/**
 * Ersetzt die Anordnung der Warengruppe an der Kasse komplett. Eine leere Liste entfernt sie
 * (= Standard-Layout). Die Einträge sind schon per Schema geprüft (eindeutig, Position/ausgeblendet).
 */
export async function speichereKassenLayout(
  db: Db,
  mandantId: string,
  kasseId: string,
  kategorieId: string,
  eintraege: readonly KasseArtikelLayoutEintrag[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await pruefeKasse(tx, mandantId, kasseId)
    await pruefeGruppe(tx, mandantId, kategorieId)
    await sperre(tx, `kasse-artikel-layout:${kasseId}:${kategorieId}`)
    await pruefeArtikel(tx, mandantId, kategorieId, eintraege.map(e => e.artikelId))
    await tx.delete(kasseArtikelLayout)
      .where(and(eq(kasseArtikelLayout.kasseId, kasseId), eq(kasseArtikelLayout.kategorieId, kategorieId)))
    if (eintraege.length > 0) {
      await tx.insert(kasseArtikelLayout).values(eintraege.map(e => ({
        mandantId,
        kasseId,
        kategorieId,
        artikelId:    e.artikelId,
        position:     e.ausgeblendet ? null : e.position,
        ausgeblendet: e.ausgeblendet,
      })))
    }
  })
}

/** Entfernt die Anordnung der Warengruppe an der Kasse (zurück auf das Standard-Layout). Idempotent. */
export async function loescheKassenLayout(db: Db, mandantId: string, kasseId: string, kategorieId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await pruefeKasse(tx, mandantId, kasseId)
    await pruefeGruppe(tx, mandantId, kategorieId)
    await sperre(tx, `kasse-artikel-layout:${kasseId}:${kategorieId}`)
    await tx.delete(kasseArtikelLayout)
      .where(and(eq(kasseArtikelLayout.kasseId, kasseId), eq(kasseArtikelLayout.kategorieId, kategorieId)))
  })
}

// ---------------------------------------------------------------------------
// Standard-Raster (gilt für alle Kassen ohne eigene Anordnung)
// ---------------------------------------------------------------------------

/**
 * Setzt für die genannten Artikel der Warengruppe Slot (raster_position) und Reihenfolge (= Slot);
 * position null löscht den Slot (der Artikel kommt dann hinten dran, `reihenfolge` bleibt).
 * Nicht genannte Artikel bleiben unverändert. Alles in einer Transaktion.
 */
export async function speichereStandardRaster(
  db: Db,
  mandantId: string,
  kategorieId: string,
  eintraege: readonly StandardRasterEintrag[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await pruefeGruppe(tx, mandantId, kategorieId)
    await sperre(tx, `standard-raster:${kategorieId}`)
    await pruefeArtikel(tx, mandantId, kategorieId, eintraege.map(e => e.artikelId))
    const jetzt = new Date()
    for (const e of eintraege) {
      await tx.update(artikel)
        .set({
          rasterPosition: e.position,
          ...(e.position !== null && { reihenfolge: e.position }),
          updatedAt: jetzt,
        })
        .where(and(eq(artikel.id, e.artikelId), eq(artikel.mandantId, mandantId), eq(artikel.kategorieId, kategorieId)))
    }
  })
}
