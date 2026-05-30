import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  BarzahlungsbelegInput,
  ModifikatorAuswahl,
  TabEreignis,
  TabPosition,
  TischTabBezahlenInput,
  TischTabErstellenInput,
  TischTabSplittenInput,
  TischTabUmbuchenInput,
  TischTabUmbenennenInput,
  TischTabResponse,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, kassen, modifikatoren, tabEreignisse, tischTabs } from '../db/schema.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { erstelleBarzahlungsbeleg } from './beleg.service.js'

export interface TischTabServiceDeps {
  db:        Db
  belegDeps: BelegServiceDeps
}

export class TischTabError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Interner Log-Helper
// ---------------------------------------------------------------------------

async function logEreignis(
  tabId:     string,
  mandantId: string,
  typ:       typeof tabEreignisse.$inferInsert['typ'],
  details:   Record<string, unknown>,
  db:        Db,
): Promise<void> {
  await db.insert(tabEreignisse).values({ tabId, mandantId, typ, details })
}

// ---------------------------------------------------------------------------
// Lagerstand-Helper
// ---------------------------------------------------------------------------

/**
 * Eindeutiger Schlüssel pro Position (artikelId + sortierte modifikatorIds).
 * Positionen mit unterschiedlichen Varianten bekommen unterschiedliche Keys.
 */
function positionKey(p: TabPosition): string {
  const modIds = (p.modifikatoren ?? []).map((m: ModifikatorAuswahl) => m.modifikatorId).sort().join(',')
  return `${p.artikelId}::${modIds}`
}

interface PositionSnapshot {
  artikelId:     string
  menge:         number
  modifikatoren: ModifikatorAuswahl[]
}

/**
 * Vergleicht alte und neue Positionen und passt den Lagerstand an.
 * delta > 0 = Abzug (mehr bestellt), delta < 0 = Rückbuchung (storniert).
 */
async function aktualisiereStockDeltas(
  altePositionen: TabPosition[],
  neuePositionen: TabPosition[],
  db: Db,
): Promise<void> {
  // Snapshots aufbauen
  const altMap = new Map<string, PositionSnapshot>()
  for (const p of altePositionen) {
    const key = positionKey(p)
    const ex  = altMap.get(key)
    altMap.set(key, {
      artikelId:     p.artikelId,
      menge:         (ex?.menge ?? 0) + p.menge,
      modifikatoren: p.modifikatoren ?? [],
    })
  }
  const neuMap = new Map<string, PositionSnapshot>()
  for (const p of neuePositionen) {
    const key = positionKey(p)
    const ex  = neuMap.get(key)
    neuMap.set(key, {
      artikelId:     p.artikelId,
      menge:         (ex?.menge ?? 0) + p.menge,
      modifikatoren: p.modifikatoren ?? [],
    })
  }

  // Deltas berechnen
  const allKeys = new Set([...altMap.keys(), ...neuMap.keys()])
  type StockDelta = { type: 'artikel'; id: string; delta: number }
                 | { type: 'modifikator'; id: string; delta: number }
  const deltas: StockDelta[] = []

  for (const key of allKeys) {
    const alt   = altMap.get(key)
    const neu   = neuMap.get(key)
    const delta = (neu?.menge ?? 0) - (alt?.menge ?? 0)
    if (delta === 0) continue

    const mods = neu?.modifikatoren ?? alt?.modifikatoren ?? []
    if (mods.length > 0) {
      for (const m of mods) {
        deltas.push({ type: 'modifikator', id: m.modifikatorId, delta })
      }
    } else {
      const artikelId = neu?.artikelId ?? alt?.artikelId
      if (artikelId) deltas.push({ type: 'artikel', id: artikelId, delta })
    }
  }

  if (deltas.length === 0) return

  // Artikel-Deltas anwenden (nur wenn lagerstandAktiv = true)
  const artikelDeltas = deltas.filter(d => d.type === 'artikel') as { type: 'artikel'; id: string; delta: number }[]
  if (artikelDeltas.length > 0) {
    const artikelIds = artikelDeltas.map(d => d.id)
    const rows = await db
      .select({ id: artikel.id, lagerstandAktiv: artikel.lagerstandAktiv, lagerstandMenge: artikel.lagerstandMenge })
      .from(artikel)
      .where(inArray(artikel.id, artikelIds))

    for (const row of rows) {
      if (!row.lagerstandAktiv || row.lagerstandMenge === null) continue
      const d = artikelDeltas.find(x => x.id === row.id)
      if (!d) continue
      const neueMenge = Math.max(0, row.lagerstandMenge - d.delta)
      await db.update(artikel)
        .set({ lagerstandMenge: neueMenge, updatedAt: new Date() })
        .where(eq(artikel.id, row.id))
    }
  }

  // Modifikator-Deltas anwenden (nur wenn lagerstandMenge gesetzt)
  const modDeltas = deltas.filter(d => d.type === 'modifikator') as { type: 'modifikator'; id: string; delta: number }[]
  if (modDeltas.length > 0) {
    const modIds = modDeltas.map(d => d.id)
    const rows = await db
      .select({ id: modifikatoren.id, lagerstandMenge: modifikatoren.lagerstandMenge })
      .from(modifikatoren)
      .where(inArray(modifikatoren.id, modIds))

    for (const row of rows) {
      if (row.lagerstandMenge === null) continue
      const d = modDeltas.find(x => x.id === row.id)
      if (!d) continue
      const neueMenge = Math.max(0, row.lagerstandMenge - d.delta)
      await db.update(modifikatoren)
        .set({ lagerstandMenge: neueMenge })
        .where(eq(modifikatoren.id, row.id))
    }
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function berechneGesamtCent(positionen: TabPosition[]): number {
  return positionen.reduce((sum, p) => sum + p.preisBruttoCent * p.menge, 0)
}

function toResponse(row: typeof tischTabs.$inferSelect): TischTabResponse {
  const positionen = (row.positionen as TabPosition[]) ?? []
  return {
    id:              row.id,
    kasseId:         row.kasseId,
    tischNummer:     row.tischNummer,
    kellner:         row.kellner,
    positionen,
    status:          row.status as 'offen' | 'bezahlt',
    summeGesamtCent: berechneGesamtCent(positionen),
    geoffnetAm:      row.geoffnetAm.toISOString(),
    createdAt:       row.createdAt.toISOString(),
    updatedAt:       row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listOffeneTabs(
  mandantId: string,
  kasseId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse[]> {
  const rows = await deps.db
    .select()
    .from(tischTabs)
    .where(and(
      eq(tischTabs.mandantId, mandantId),
      eq(tischTabs.kasseId, kasseId),
      eq(tischTabs.status, 'offen'),
    ))
    .orderBy(tischTabs.geoffnetAm)
  return rows.map(toResponse)
}

export async function erstelleTab(
  input: TischTabErstellenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [kasse] = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new TischTabError(404, 'Kasse nicht gefunden')

  const [row] = await deps.db
    .insert(tischTabs)
    .values({
      mandantId,
      kasseId:     input.kasseId,
      tischNummer: input.tischNummer,
      kellner:     input.kellner,
      positionen:  [],
      status:      'offen',
      geoffnetAm:  new Date(),
    })
    .returning()
  if (!row) throw new TischTabError(500, 'Tab konnte nicht erstellt werden')

  await logEreignis(row.id, mandantId, 'geoeffnet', {
    tischNummer: input.tischNummer,
    kellner:     input.kellner,
  }, deps.db)

  return toResponse(row)
}

export async function getTab(
  id: string,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [row] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  return toResponse(row)
}

export async function aktualisierePositionen(
  id: string,
  positionen: TabPosition[],
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [existing] = await deps.db
    .select({ id: tischTabs.id, status: tischTabs.status, positionen: tischTabs.positionen })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  // altePositionen VOR dem Update sichern
  const altePositionen = (existing.positionen as TabPosition[]) ?? []

  const [row] = await deps.db
    .update(tischTabs)
    .set({ positionen, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Update fehlgeschlagen')

  // Lagerstand automatisch anpassen
  await aktualisiereStockDeltas(altePositionen, positionen, deps.db)

  // Storno-Erkennung: welche Positionen wurden reduziert oder entfernt?
  const neueMap = new Map(positionen.map(p => [p.artikelId, p]))
  const stornoItems: Array<{ bezeichnung: string; menge: number; preisBruttoCent: number }> = []

  for (const alt of altePositionen) {
    const neu = neueMap.get(alt.artikelId)
    const neuMenge = neu?.menge ?? 0
    if (neuMenge < alt.menge) {
      stornoItems.push({
        bezeichnung:     alt.bezeichnung,
        menge:           alt.menge - neuMenge,
        preisBruttoCent: alt.preisBruttoCent,
      })
    }
  }

  if (stornoItems.length > 0) {
    await logEreignis(id, mandantId, 'storno', { positionen: stornoItems }, deps.db)
  }

  await logEreignis(id, mandantId, 'positionen_aktualisiert', {
    positionen: positionen.map(p => ({
      bezeichnung:     p.bezeichnung,
      menge:           p.menge,
      preisBruttoCent: p.preisBruttoCent,
    })),
  }, deps.db)

  return toResponse(row)
}

export async function bezahleTab(
  id: string,
  input: TischTabBezahlenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<{ tab: TischTabResponse; belegId: string }> {
  const [existing] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist bereits bezahlt')

  const positionen = (existing.positionen as TabPosition[]) ?? []
  if (positionen.length === 0) throw new TischTabError(400, 'Keine Positionen im Tab')

  const belegPositionen: BarzahlungsbelegInput['positionen'] = positionen.map((p, i) => {
    const posRabatt = input.positionRabatte?.find(r => r.positionIndex === i)
    return {
      artikelId:              p.artikelId,
      menge:                  p.menge,
      einzelpreisBreuttoCent: posRabatt?.einzelpreisBreuttoCent ?? p.preisBruttoCent,
      ...(p.modifikatoren?.length
        ? { bezeichnungZusatz: p.modifikatoren.map((m: { name: string }) => m.name).join(', ') }
        : {}),
    }
  })

  const trinkgeldCent = input.trinkgeldCent ?? 0
  if (trinkgeldCent > 0) {
    belegPositionen.push({
      bezeichnung:     'Trinkgeld',
      preisBruttoCent: trinkgeldCent,
      mwstSatz:        'null',
      menge:           1,
    })
  }

  const zahlungMitTrinkgeld = trinkgeldCent > 0
    ? { ...input.zahlung, karteCent: input.zahlung.karteCent + trinkgeldCent }
    : input.zahlung

  const beleg = await erstelleBarzahlungsbeleg({
    kasseId:   existing.kasseId,
    positionen: belegPositionen,
    zahlung:    zahlungMitTrinkgeld,
    ...(input.rabatt && { rabatt: input.rabatt }),
  }, deps.belegDeps)

  const [row] = await deps.db
    .update(tischTabs)
    .set({ status: 'bezahlt', geschlossenAm: new Date(), belegId: beleg.id, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Tab konnte nicht geschlossen werden')

  await logEreignis(id, mandantId, 'bezahlt', {
    belegId:      beleg.id,
    gesamtCent:   berechneGesamtCent(positionen),
    barCent:      input.zahlung.barCent,
    karteCent:    input.zahlung.karteCent,
    sonstigeCent: input.zahlung.sonstigeCent,
  }, deps.db)

  return { tab: toResponse(row), belegId: beleg.id }
}

export async function umbenneneTab(
  id: string,
  input: TischTabUmbenennenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [existing] = await deps.db
    .select({ id: tischTabs.id, status: tischTabs.status, kellner: tischTabs.kellner })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  const [row] = await deps.db
    .update(tischTabs)
    .set({ kellner: input.kellner, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Umbenennung fehlgeschlagen')

  await logEreignis(id, mandantId, 'kellner_umbenannt', {
    von:  existing.kellner,
    nach: input.kellner,
  }, deps.db)

  return toResponse(row)
}

export async function umbucheTab(
  id: string,
  input: TischTabUmbuchenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [existing] = await deps.db
    .select({ id: tischTabs.id, status: tischTabs.status, tischNummer: tischTabs.tischNummer })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  const [row] = await deps.db
    .update(tischTabs)
    .set({ tischNummer: input.tischNummer, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Umbuchung fehlgeschlagen')

  await logEreignis(id, mandantId, 'tisch_gewechselt', {
    von:  existing.tischNummer,
    nach: input.tischNummer,
  }, deps.db)

  return toResponse(row)
}

export async function splitteUndBezahleTab(
  id: string,
  input: TischTabSplittenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<{ tab: TischTabResponse; belegIds: string[] }> {
  const [existing] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist bereits bezahlt')

  const belegIds: string[] = []
  for (const zahlung of input.zahlungen) {
    const beleg = await erstelleBarzahlungsbeleg({
      kasseId:    existing.kasseId,
      positionen: zahlung.positionen.map(p => ({ artikelId: p.artikelId, menge: p.menge })),
      zahlung:    zahlung.zahlung,
    }, deps.belegDeps)
    belegIds.push(beleg.id)
  }

  const [row] = await deps.db
    .update(tischTabs)
    .set({ status: 'bezahlt', geschlossenAm: new Date(), updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Tab konnte nicht geschlossen werden')

  const gesamtCent = input.zahlungen.reduce(
    (s, z) => s + z.positionen.reduce((ps, p) => ps + p.preisBruttoCent * p.menge, 0), 0
  )
  await logEreignis(id, mandantId, 'gesplittet', {
    anzahlZahler: input.zahlungen.length,
    belegIds,
    gesamtCent,
  }, deps.db)

  return { tab: toResponse(row), belegIds }
}

// ---------------------------------------------------------------------------
// Verlauf (Audit-Log)
// ---------------------------------------------------------------------------

export async function getTabVerlauf(
  id: string,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TabEreignis[]> {
  // Tab-Zugehörigkeit prüfen
  const [existing] = await deps.db
    .select({ id: tischTabs.id })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')

  const rows = await deps.db
    .select()
    .from(tabEreignisse)
    .where(eq(tabEreignisse.tabId, id))
    .orderBy(desc(tabEreignisse.createdAt))

  return rows.map(r => ({
    id:        r.id,
    typ:       r.typ as TabEreignis['typ'],
    details:   r.details as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Bonierung-Ereignis (wird vom Bonier-Service aufgerufen)
// ---------------------------------------------------------------------------

export async function logBonierEreignis(
  tabId:     string,
  mandantId: string,
  details:   Record<string, unknown>,
  db:        Db,
): Promise<void> {
  await logEreignis(tabId, mandantId, 'bonierung', details, db)
}
