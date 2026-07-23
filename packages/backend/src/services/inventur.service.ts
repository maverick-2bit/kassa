/**
 * Inventur-Service — dokumentierte, datierte Bestandsaufnahme.
 *
 * Ablauf: anlegen (snapshottet Soll = aktueller Lagerstand aller lagergeführten Artikel)
 * → zählen (Ist erfassen) → abschließen (bucht Ist absolut auf artikel.lagerstandMenge,
 * nur gezählte Positionen; Muster wie lagerstand.service.ts 'absolut'). Alles pro Mandant
 * isoliert; Abschluss ist ein idempotenter Status-Claim in einer Transaktion.
 */

import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { artikel, inventurPositionen, inventuren } from '../db/schema.js'

export class InventurError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface InventurListeEintrag {
  id:              string
  bezeichnung:     string
  status:          string
  erstelltVon:     string
  createdAt:       Date
  abgeschlossenAm: Date | null
  anzahlPositionen: number
  anzahlGezaehlt:   number
}

export interface InventurPositionDto {
  artikelId:   string
  bezeichnung: string
  sollMenge:   number
  istMenge:    number | null
  differenz:   number | null
}

export interface InventurDetail {
  id:              string
  bezeichnung:     string
  status:          string
  erstelltVon:     string
  createdAt:       Date
  abgeschlossenAm: Date | null
  positionen:      InventurPositionDto[]
}

function heuteBezeichnung(jetzt: Date): string {
  return `Inventur ${jetzt.toISOString().slice(0, 10)}`
}

// ---------------------------------------------------------------------------
// Anlegen — Soll-Snapshot aller lagergeführten (aktiven) Artikel
// ---------------------------------------------------------------------------

export async function erstelleInventur(
  mandantId:   string,
  erstelltVon: string,
  bezeichnung: string | undefined,
  db:          Db,
): Promise<{ id: string }> {
  const artikelRows = await db
    .select({ id: artikel.id, bezeichnung: artikel.bezeichnung, lagerstandMenge: artikel.lagerstandMenge })
    .from(artikel)
    .where(and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true), eq(artikel.lagerstandAktiv, true)))
    .orderBy(asc(artikel.bezeichnung))

  if (artikelRows.length === 0) {
    throw new InventurError(400, 'Keine lagergeführten Artikel vorhanden — Inventur nicht möglich')
  }

  return await db.transaction(async (tx) => {
    const [kopf] = await tx.insert(inventuren).values({
      mandantId,
      bezeichnung: bezeichnung?.trim() || heuteBezeichnung(new Date()),
      status:      'offen',
      erstelltVon,
    }).returning({ id: inventuren.id })
    if (!kopf) throw new InventurError(500, 'Inventur konnte nicht angelegt werden')

    await tx.insert(inventurPositionen).values(
      artikelRows.map(a => ({
        inventurId:  kopf.id,
        artikelId:   a.id,
        bezeichnung: a.bezeichnung,
        sollMenge:   a.lagerstandMenge ?? 0,
        istMenge:    null,
      })),
    )
    return { id: kopf.id }
  })
}

// ---------------------------------------------------------------------------
// Liste (mit Zähl-Fortschritt)
// ---------------------------------------------------------------------------

export async function listeInventuren(mandantId: string, db: Db): Promise<InventurListeEintrag[]> {
  const koepfe = await db
    .select()
    .from(inventuren)
    .where(eq(inventuren.mandantId, mandantId))
    .orderBy(desc(inventuren.createdAt))

  if (koepfe.length === 0) return []

  const ids = koepfe.map(k => k.id)
  const counts = await db
    .select({
      inventurId: inventurPositionen.inventurId,
      gesamt:     count(),
      gezaehlt:   count(inventurPositionen.istMenge),
    })
    .from(inventurPositionen)
    .where(inArray(inventurPositionen.inventurId, ids))
    .groupBy(inventurPositionen.inventurId)

  const byId = new Map(counts.map(c => [c.inventurId, c]))
  return koepfe.map(k => ({
    id:              k.id,
    bezeichnung:     k.bezeichnung,
    status:          k.status,
    erstelltVon:     k.erstelltVon,
    createdAt:       k.createdAt,
    abgeschlossenAm: k.abgeschlossenAm,
    anzahlPositionen: Number(byId.get(k.id)?.gesamt ?? 0),
    anzahlGezaehlt:   Number(byId.get(k.id)?.gezaehlt ?? 0),
  }))
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function ladeKopf(id: string, mandantId: string, db: Db) {
  const [kopf] = await db
    .select()
    .from(inventuren)
    .where(and(eq(inventuren.id, id), eq(inventuren.mandantId, mandantId)))
    .limit(1)
  if (!kopf) throw new InventurError(404, 'Inventur nicht gefunden')
  return kopf
}

export async function holeInventur(id: string, mandantId: string, db: Db): Promise<InventurDetail> {
  const kopf = await ladeKopf(id, mandantId, db)
  const positionen = await db
    .select()
    .from(inventurPositionen)
    .where(eq(inventurPositionen.inventurId, id))
    .orderBy(asc(inventurPositionen.bezeichnung))

  return {
    id:              kopf.id,
    bezeichnung:     kopf.bezeichnung,
    status:          kopf.status,
    erstelltVon:     kopf.erstelltVon,
    createdAt:       kopf.createdAt,
    abgeschlossenAm: kopf.abgeschlossenAm,
    positionen: positionen.map(p => ({
      artikelId:   p.artikelId,
      bezeichnung: p.bezeichnung,
      sollMenge:   p.sollMenge,
      istMenge:    p.istMenge,
      differenz:   p.istMenge === null ? null : p.istMenge - p.sollMenge,
    })),
  }
}

// ---------------------------------------------------------------------------
// Zählung erfassen (nur solange offen)
// ---------------------------------------------------------------------------

export async function erfasseZaehlung(
  id:         string,
  mandantId:  string,
  positionen: { artikelId: string; istMenge: number | null }[],
  db:         Db,
): Promise<void> {
  const kopf = await ladeKopf(id, mandantId, db)
  if (kopf.status !== 'offen') throw new InventurError(409, 'Inventur ist bereits abgeschlossen')

  await db.transaction(async (tx) => {
    for (const p of positionen) {
      await tx
        .update(inventurPositionen)
        .set({ istMenge: p.istMenge })
        .where(and(eq(inventurPositionen.inventurId, id), eq(inventurPositionen.artikelId, p.artikelId)))
    }
  })
}

// ---------------------------------------------------------------------------
// Abschließen — gezählte Ist-Mengen absolut auf den Lagerstand buchen
// ---------------------------------------------------------------------------

export async function schliesseInventurAb(
  id:        string,
  mandantId: string,
  db:        Db,
): Promise<{ gebucht: number; ungezaehlt: number }> {
  return await db.transaction(async (tx) => {
    // Idempotenter Claim: nur ein Aufrufer darf offen → abgeschlossen buchen
    const [claimed] = await tx
      .update(inventuren)
      .set({ status: 'abgeschlossen', abgeschlossenAm: new Date() })
      .where(and(eq(inventuren.id, id), eq(inventuren.mandantId, mandantId), eq(inventuren.status, 'offen')))
      .returning({ id: inventuren.id })

    if (!claimed) {
      const [aktuell] = await tx
        .select({ status: inventuren.status })
        .from(inventuren)
        .where(and(eq(inventuren.id, id), eq(inventuren.mandantId, mandantId)))
        .limit(1)
      if (!aktuell) throw new InventurError(404, 'Inventur nicht gefunden')
      throw new InventurError(409, 'Inventur ist bereits abgeschlossen')
    }

    const positionen = await tx
      .select({ artikelId: inventurPositionen.artikelId, istMenge: inventurPositionen.istMenge })
      .from(inventurPositionen)
      .where(eq(inventurPositionen.inventurId, id))

    let gebucht = 0, ungezaehlt = 0
    for (const p of positionen) {
      if (p.istMenge === null) { ungezaehlt++; continue }
      // Absolut setzen — mandantId- + lagerstandAktiv-Guard (Muster lagerstand.service.ts)
      await tx
        .update(artikel)
        .set({ lagerstandMenge: p.istMenge, updatedAt: new Date() })
        .where(and(eq(artikel.id, p.artikelId), eq(artikel.mandantId, mandantId), eq(artikel.lagerstandAktiv, true)))
      gebucht++
    }
    return { gebucht, ungezaehlt }
  })
}

// ---------------------------------------------------------------------------
// Löschen (nur offene) + CSV-Protokoll
// ---------------------------------------------------------------------------

export async function loescheInventur(id: string, mandantId: string, db: Db): Promise<void> {
  const kopf = await ladeKopf(id, mandantId, db)
  if (kopf.status !== 'offen') throw new InventurError(409, 'Nur offene Inventuren können gelöscht werden')
  await db.delete(inventuren).where(and(eq(inventuren.id, id), eq(inventuren.mandantId, mandantId)))
}

export async function inventurProtokollCsv(id: string, mandantId: string, db: Db): Promise<{ dateiname: string; csv: string }> {
  const detail = await holeInventur(id, mandantId, db)
  const zeilen = ['Artikel;Soll;Ist;Differenz']
  for (const p of detail.positionen) {
    const ist = p.istMenge === null ? '' : String(p.istMenge)
    const diff = p.differenz === null ? '' : String(p.differenz)
    // Semikolon-getrennt (DE-Excel); Bezeichnung in Anführungszeichen, interne " verdoppelt
    zeilen.push(`"${p.bezeichnung.replace(/"/g, '""')}";${p.sollMenge};${ist};${diff}`)
  }
  const datum = detail.createdAt.toISOString().slice(0, 10)
  return { dateiname: `inventur-${datum}.csv`, csv: zeilen.join('\r\n') + '\r\n' }
}
