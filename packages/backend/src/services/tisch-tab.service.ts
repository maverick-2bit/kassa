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
  TischTabZusammenfuehrenInput,
  TischTabVerschiebenInput,
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
    status:          row.status as 'offen' | 'bezahlt' | 'zusammengefuehrt',
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
  }, deps.belegDeps, { skipLagerstand: true })  // Tisch: Lager läuft über Positionsänderung

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

/**
 * Führt mehrere offene Tabs (z. B. Gruppen an einem Tisch) in einen Ziel-Tab
 * zusammen: die Positionen der Quell-Tabs werden an den Ziel-Tab angehängt, die
 * Quell-Tabs auf Status 'zusammengefuehrt' geschlossen. Alles in EINER Tx mit
 * FOR-UPDATE-Sperren, damit ein paralleles Bezahlen/Umbuchen nicht dazwischenfunkt.
 * Vorfiskalisch — es entsteht kein Beleg; nur beim Bezahlen des Ziel-Tabs.
 */
export async function verschmelzeTabs(
  zielId: string,
  input: TischTabZusammenfuehrenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const quellIds = [...new Set(input.quellTabIds)].filter(qid => qid !== zielId)
  if (quellIds.length === 0) throw new TischTabError(400, 'Keine Quell-Tabs zum Zusammenführen')

  return deps.db.transaction(async (tx) => {
    // Ziel-Tab sperren + validieren
    const [ziel] = await tx
      .select()
      .from(tischTabs)
      .where(and(eq(tischTabs.id, zielId), eq(tischTabs.mandantId, mandantId)))
      .for('update')
      .limit(1)
    if (!ziel) throw new TischTabError(404, 'Ziel-Tisch nicht gefunden')
    if (ziel.status !== 'offen') throw new TischTabError(409, 'Ziel-Tisch ist nicht mehr offen')

    // Quell-Tabs sperren + validieren (alle offen, gleiche Kasse)
    const quellen = await tx
      .select()
      .from(tischTabs)
      .where(and(inArray(tischTabs.id, quellIds), eq(tischTabs.mandantId, mandantId)))
      .for('update')
    if (quellen.length !== quellIds.length) throw new TischTabError(404, 'Ein zusammenzuführender Tisch wurde nicht gefunden')
    for (const q of quellen) {
      if (q.status !== 'offen')      throw new TischTabError(409, `Gruppe „${q.tischNummer}" ist nicht mehr offen`)
      if (q.kasseId !== ziel.kasseId) throw new TischTabError(400, 'Tische gehören zu verschiedenen Kassen')
    }

    // Positionen anhängen
    const zielPos  = (ziel.positionen as TabPosition[]) ?? []
    const quellPos = quellen.flatMap(q => (q.positionen as TabPosition[]) ?? [])
    const jetzt    = new Date()

    const [zielRow] = await tx
      .update(tischTabs)
      .set({ positionen: [...zielPos, ...quellPos], updatedAt: jetzt })
      .where(eq(tischTabs.id, zielId))
      .returning()
    if (!zielRow) throw new TischTabError(500, 'Zusammenführen fehlgeschlagen')

    // Quell-Tabs schließen + Ereignisse protokollieren
    for (const q of quellen) {
      await tx
        .update(tischTabs)
        .set({ status: 'zusammengefuehrt', geschlossenAm: jetzt, updatedAt: jetzt })
        .where(eq(tischTabs.id, q.id))
      await tx.insert(tabEreignisse).values({
        tabId:   q.id,
        mandantId,
        typ:     'zusammengefuehrt',
        details: { zielTabId: zielId, zielTisch: ziel.tischNummer, positionen: (q.positionen as TabPosition[])?.length ?? 0 },
      })
    }
    await tx.insert(tabEreignisse).values({
      tabId:   zielId,
      mandantId,
      typ:     'zusammengefuehrt',
      details: {
        quellTabIds:      quellen.map(q => q.id),
        quellTische:      quellen.map(q => q.tischNummer),
        anzahlPositionen: quellPos.length,
      },
    })

    return toResponse(zielRow)
  })
}

/**
 * Teilweises Umbuchen: verschiebt eine Teilmenge von Positionen vom Quell-Tab auf
 * einen anderen offenen Tisch (per Tischnummer; existiert dort keiner, wird er
 * angelegt). Transaktional + `FOR UPDATE` (Muster verschmelzeTabs).
 *
 * LAGERNEUTRAL: Die Artikel bleiben in einem offenen Tab — daher KEIN
 * aktualisiereStockDeltas (sonst würde der Abzug auf B + die Rückbuchung auf A den
 * „einzige-Lagerquelle"-Invariant verletzen und ein Fehl-Storno loggen). Genau wie
 * verschmelzeTabs rührt der Move den Lagerstand nicht an.
 */
export async function verschiebePositionen(
  quellId: string,
  input: TischTabVerschiebenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<{ quelle: TischTabResponse; ziel: TischTabResponse }> {
  const zielTischNummer = input.zielTischNummer.trim()
  if (input.positionen.length === 0) throw new TischTabError(400, 'Keine Positionen zum Umbuchen')

  return deps.db.transaction(async (tx) => {
    // Quell-Tab sperren + validieren
    const [quelle] = await tx
      .select()
      .from(tischTabs)
      .where(and(eq(tischTabs.id, quellId), eq(tischTabs.mandantId, mandantId)))
      .for('update')
      .limit(1)
    if (!quelle) throw new TischTabError(404, 'Quell-Tisch nicht gefunden')
    if (quelle.status !== 'offen') throw new TischTabError(409, 'Quell-Tisch ist nicht mehr offen')
    if (zielTischNummer === quelle.tischNummer) throw new TischTabError(400, 'Ziel-Tisch ist derselbe wie der Quell-Tisch')

    // Zu verschiebende Menge je Positions-Schlüssel (Varianten getrennt) aufsummieren
    const moveByKey = new Map<string, number>()
    for (const mp of input.positionen) {
      const k = positionKey(mp)
      moveByKey.set(k, (moveByKey.get(k) ?? 0) + mp.menge)
    }

    // Quell-Positionen durchgehen: gewünschte Mengen abziehen, Bewegtes sammeln
    const quellPos    = (quelle.positionen as TabPosition[]) ?? []
    const neueQuellPos: TabPosition[] = []
    const bewegtePos:  TabPosition[] = []
    for (const p of quellPos) {
      const k    = positionKey(p)
      const move = moveByKey.get(k) ?? 0
      if (move <= 0) { neueQuellPos.push(p); continue }
      const nimm = Math.min(move, p.menge)
      moveByKey.set(k, move - nimm)
      if (nimm > 0)              bewegtePos.push({ ...p, menge: nimm })
      if (p.menge - nimm > 0)    neueQuellPos.push({ ...p, menge: p.menge - nimm })
    }
    for (const rest of moveByKey.values()) {
      if (rest > 0) throw new TischTabError(400, 'Zu verschiebende Menge übersteigt den Bestand des Tisches')
    }
    if (bewegtePos.length === 0) throw new TischTabError(400, 'Keine passenden Positionen zum Umbuchen gefunden')

    const jetzt = new Date()

    // Ziel-Tab: offener Tab mit der Tischnummer (gleiche Kasse) — oder neu anlegen
    let [ziel] = await tx
      .select()
      .from(tischTabs)
      .where(and(
        eq(tischTabs.mandantId, mandantId),
        eq(tischTabs.kasseId, quelle.kasseId),
        eq(tischTabs.tischNummer, zielTischNummer),
        eq(tischTabs.status, 'offen'),
      ))
      .for('update')
      .limit(1)
    if (!ziel) {
      const [neu] = await tx
        .insert(tischTabs)
        .values({
          mandantId, kasseId: quelle.kasseId, tischNummer: zielTischNummer,
          kellner: quelle.kellner, positionen: [], status: 'offen', geoffnetAm: jetzt,
        })
        .returning()
      if (!neu) throw new TischTabError(500, 'Ziel-Tisch konnte nicht angelegt werden')
      await tx.insert(tabEreignisse).values({
        tabId: neu.id, mandantId, typ: 'geoeffnet',
        details: { tischNummer: zielTischNummer, kellner: quelle.kellner },
      })
      ziel = neu
    }

    // Bewegte Positionen an den Ziel-Tab anhängen; gleicher positionKey → mengen mergen
    const zielMap = new Map<string, TabPosition>()
    const reihenfolge: string[] = []
    for (const p of [...((ziel.positionen as TabPosition[]) ?? []), ...bewegtePos]) {
      const k  = positionKey(p)
      const ex = zielMap.get(k)
      if (ex) ex.menge += p.menge
      else { zielMap.set(k, { ...p }); reihenfolge.push(k) }
    }
    const neueZielPos = reihenfolge.map(k => zielMap.get(k)!)

    // Schreiben (KEIN Lagerabzug — Move ist lagerneutral)
    const [quellRow] = await tx.update(tischTabs)
      .set({ positionen: neueQuellPos, updatedAt: jetzt })
      .where(eq(tischTabs.id, quellId)).returning()
    const [zielRow] = await tx.update(tischTabs)
      .set({ positionen: neueZielPos, updatedAt: jetzt })
      .where(eq(tischTabs.id, ziel.id)).returning()
    if (!quellRow || !zielRow) throw new TischTabError(500, 'Umbuchen fehlgeschlagen')

    const anzahl = bewegtePos.reduce((s, p) => s + p.menge, 0)
    await tx.insert(tabEreignisse).values({
      tabId: quellId, mandantId, typ: 'positionen_verschoben',
      details: { richtung: 'raus', zielTabId: ziel.id, zielTisch: zielTischNummer, anzahl },
    })
    await tx.insert(tabEreignisse).values({
      tabId: ziel.id, mandantId, typ: 'positionen_verschoben',
      details: { richtung: 'rein', quellTabId: quellId, quellTisch: quelle.tischNummer, anzahl },
    })

    return { quelle: toResponse(quellRow), ziel: toResponse(zielRow) }
  })
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
    }, deps.belegDeps, { skipLagerstand: true })  // Tisch: Lager läuft über Positionsänderung
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
