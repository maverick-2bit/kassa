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
  BonierZielFehler,
} from '@kassa/shared'
import { bonierFehlschlaege } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, auditLogs, kassen, modifikatoren, tabEreignisse, tischTabs } from '../db/schema.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { BelegError, erstelleBarzahlungsbeleg } from './beleg.service.js'
import { ladeRezepte, wendeBestandteilDeltasAn } from './bestandteil.service.js'
import { bonierBestellung } from './bonier.service.js'
import { pruefeStornoFreigabe, type FreigabeKontext } from './freigabe.service.js'

export interface TischTabServiceDeps {
  db:        Db
  belegDeps: BelegServiceDeps
}

/** Nicht zugestellter Korrekturbon samt der Positionen zum Nachsenden. */
export interface StornoBonErgebnis {
  fehler:     BonierZielFehler[]
  positionen: Array<{ artikelId: string; menge: number }>
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

  // Bestandteil-Deltas (Rezepte) anwenden — netto je Artikel, unabhängig von
  // Modifikator-Varianten: zusammengesetzte Artikel buchen ihre Bestandteile ab,
  // egal ob mit oder ohne Variante bestellt. delta>0 = Abzug, delta<0 = Rückbuchung.
  const artikelNettoDelta = new Map<string, number>()
  for (const key of allKeys) {
    const alt = altMap.get(key)
    const neu = neuMap.get(key)
    const delta = (neu?.menge ?? 0) - (alt?.menge ?? 0)
    if (delta === 0) continue
    const artikelId = neu?.artikelId ?? alt?.artikelId
    if (artikelId) artikelNettoDelta.set(artikelId, (artikelNettoDelta.get(artikelId) ?? 0) + delta)
  }
  if (artikelNettoDelta.size > 0) {
    const rezepte = await ladeRezepte(db, [...artikelNettoDelta.keys()])
    if (rezepte.size > 0) {
      await wendeBestandteilDeltasAn(
        db,
        [...artikelNettoDelta.entries()].map(([artikelId, delta]) => ({ artikelId, delta })),
        rezepte,
      )
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
  /** Für Storno-Bon + Audit: wer korrigiert (Kellner-App/Kasse) und warum */
  kontext?: {
    userId?: string | null; userName?: string; grund?: string; freigabePin?: string
    /** Wer anfragt — für die PIN-Bremse, falls ein Freigabe-PIN mitkommt */
    freigabe?: FreigabeKontext
  },
): Promise<{ tab: TischTabResponse; stornoBon: StornoBonErgebnis | null }> {
  const [existing] = await deps.db
    .select({ id: tischTabs.id, kasseId: tischTabs.kasseId, status: tischTabs.status, positionen: tischTabs.positionen })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  // altePositionen VOR dem Update sichern
  const altePositionen = (existing.positionen as TabPosition[]) ?? []

  // Storno-Erkennung VOR dem Update: welche Positionen werden reduziert oder
  // entfernt? Muss vorher passieren, weil die Freigabe-Prüfung den Vorgang
  // ablehnen können muss, ohne dass schon etwas geschrieben wurde.
  const neueMap = new Map(positionen.map(p => [p.artikelId, p]))
  const stornoItems: Array<{ artikelId: string; bezeichnung: string; menge: number; preisBruttoCent: number }> = []

  for (const alt of altePositionen) {
    const neu = neueMap.get(alt.artikelId)
    const neuMenge = neu?.menge ?? 0
    if (neuMenge < alt.menge) {
      stornoItems.push({
        artikelId:       alt.artikelId,
        bezeichnung:     alt.bezeichnung,
        menge:           alt.menge - neuMenge,
        preisBruttoCent: alt.preisBruttoCent,
      })
    }
  }

  // Freigabe-Schwelle: gleicher Mechanismus wie beim Beleg-Storno. Bewertet
  // wird der Wert des STORNIERTEN Teils — nicht der Tab-Summe. Wirft 403 mit
  // 'freigabe_erforderlich', bevor irgendetwas persistiert ist.
  if (stornoItems.length > 0) {
    const stornoWertCent = stornoItems.reduce((s, i) => s + i.menge * i.preisBruttoCent, 0)
    await pruefeStornoFreigabe(
      deps.db, mandantId, stornoWertCent, kontext?.freigabePin,
      kontext?.freigabe ? { ...kontext.freigabe, kasseId: existing.kasseId } : null,
    )
  }

  const [row] = await deps.db
    .update(tischTabs)
    .set({ positionen, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Update fehlgeschlagen')

  // Lagerstand automatisch anpassen
  await aktualisiereStockDeltas(altePositionen, positionen, deps.db)

  let stornoBon: StornoBonErgebnis | null = null
  if (stornoItems.length > 0) {
    await logEreignis(id, mandantId, 'storno', {
      positionen: stornoItems,
      ...(kontext?.userName ? { durch: kontext.userName } : {}),
      ...(kontext?.grund    ? { grund: kontext.grund } : {}),
    }, deps.db)
    stornoBon = await verarbeiteStorno(row, stornoItems, mandantId, deps, kontext)
  }

  await logEreignis(id, mandantId, 'positionen_aktualisiert', {
    positionen: positionen.map(p => ({
      bezeichnung:     p.bezeichnung,
      menge:           p.menge,
      preisBruttoCent: p.preisBruttoCent,
    })),
  }, deps.db)

  return { tab: toResponse(row), stornoBon }
}

/**
 * Gemeinsame Storno-Nacharbeit: Audit-Eintrag + Storno-Bon an die betroffenen
 * Stationen/Bonierdrucker. Der Bon läuft best-effort — ein Druckerausfall darf
 * den Storno selbst nie blockieren (er ist bereits persistiert).
 *
 * @returns die nicht erreichten Ziele samt der stornierten Positionen (damit die
 *          Oberfläche gezielt nachsenden kann), oder null wenn alles zugestellt
 *          wurde bzw. es nichts zuzustellen gab.
 */
async function verarbeiteStorno(
  tab: { id: string; kasseId: string; tischNummer: string; kellner: string },
  stornoItems: Array<{ artikelId: string; bezeichnung: string; menge: number; preisBruttoCent: number }>,
  mandantId: string,
  deps: TischTabServiceDeps,
  kontext?: { userId?: string | null; userName?: string; grund?: string },
): Promise<StornoBonErgebnis | null> {
  await deps.db.insert(auditLogs).values({
    mandantId,
    userId: kontext?.userId ?? null,
    aktion: 'tab.position_storno',
    details: {
      tabId:       tab.id,
      tisch:       tab.tischNummer,
      positionen:  stornoItems.map(s => ({ bezeichnung: s.bezeichnung, menge: s.menge, preisBruttoCent: s.preisBruttoCent })),
      ...(kontext?.userName ? { durch: kontext.userName } : {}),
      ...(kontext?.grund    ? { grund: kontext.grund } : {}),
    },
  })

  const positionen = stornoItems.map(s => ({ artikelId: s.artikelId, menge: s.menge }))

  try {
    // Dynamischer Import — bonier.service importiert seinerseits aus diesem
    // Modul (logBonierEreignis); ein statischer Import wäre zirkulär.
    const { bonierBestellung } = await import('./bonier.service.js')
    const ergebnis = await bonierBestellung({
      kasseId: tab.kasseId,
      tisch:   tab.tischNummer,
      kellner: kontext?.userName ?? tab.kellner,
      positionen,
      // ohneLagerabzug: der Storno-Bon ist reine Küchen-Info — die Rückbuchung
      // des Lagerstands macht bereits aktualisiereStockDeltas.
    }, { db: deps.db }, { storno: true, ohneLagerabzug: true })

    // Der Korrekturbon ist der ganze Sinn der Übung: an der Station steht sonst
    // weiter das stornierte Gericht auf der Liste und wird zubereitet. Kommt er
    // nicht an, muss es der Kellner erfahren — bis v0.7.149 verschwand das
    // Ergebnis hier stillschweigend.
    const fehler = bonierFehlschlaege(ergebnis)
    return fehler.length > 0 ? { fehler, positionen } : null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // „nichts zu bonieren" = kein Artikel hat Station oder Drucker. Dann gibt es
    // auch nichts zu melden — kein Fehlerfall.
    if (/nichts zu bonieren/i.test(msg)) return null
    return {
      fehler: [{ ziel: 'Küche/Schank', ip: '', fehler: msg, istBackup: false }],
      positionen,
    }
  }
}

/**
 * Gesamten offenen Tab verwerfen: alle Positionen stornieren (inkl. Storno-Bon
 * an die Küche), Tab schließen. Der Tab verschwindet aus der offenen Liste.
 */
export async function verwerfeTab(
  id: string,
  mandantId: string,
  deps: TischTabServiceDeps,
  kontext?: {
    userId?: string | null; userName?: string; grund?: string; freigabePin?: string
    freigabe?: FreigabeKontext
  },
): Promise<TischTabResponse> {
  const [existing] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  const positionen = (existing.positionen as TabPosition[]) ?? []

  // Verwerfen = Storno ALLER Positionen. Ohne diese Prüfung würde die
  // Freigabeschwelle des Positions-Stornos umgangen, indem man statt der
  // Position einfach den ganzen Tab verwirft.
  const gesamtCent = positionen.reduce((s, p) => s + p.menge * p.preisBruttoCent, 0)
  await pruefeStornoFreigabe(
    deps.db, mandantId, gesamtCent, kontext?.freigabePin,
    kontext?.freigabe ? { ...kontext.freigabe, kasseId: existing.kasseId } : null,
  )

  const [row] = await deps.db
    .update(tischTabs)
    .set({ status: 'verworfen', geschlossenAm: new Date(), updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Verwerfen fehlgeschlagen')

  // Lagerstand zurückbuchen (verworfene Positionen wurden nie verkauft)
  await aktualisiereStockDeltas(positionen, [], deps.db)

  const stornoItems = positionen.map(p => ({
    artikelId:       p.artikelId,
    bezeichnung:     p.bezeichnung,
    menge:           p.menge,
    preisBruttoCent: p.preisBruttoCent,
  }))

  await logEreignis(id, mandantId, 'verworfen', {
    positionen: stornoItems,
    ...(kontext?.userName ? { durch: kontext.userName } : {}),
    ...(kontext?.grund    ? { grund: kontext.grund } : {}),
  }, deps.db)

  if (stornoItems.length > 0) {
    await verarbeiteStorno(row, stornoItems, mandantId, deps, kontext)
  }

  return toResponse(row)
}

export async function bezahleTab(
  id: string,
  input: TischTabBezahlenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
  /** Wer anfragt — für die PIN-Bremse, falls ein Freigabe-PIN (Rabatt) mitkommt */
  freigabeKontext?: FreigabeKontext,
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

  // Positionsrabatte sind ab hier nur noch Preis-Overrides — für die
  // Rabatt-Freigabeschwelle den Nachlass VOR dem Überschreiben festhalten.
  const posNachlassCent = (input.positionRabatte ?? []).reduce((s, r) => {
    const p = positionen[r.positionIndex]
    if (!p) return s
    return s + Math.max(0, (p.preisBruttoCent - r.einzelpreisBreuttoCent) * p.menge)
  }, 0)

  const beleg = await erstelleBarzahlungsbeleg({
    kasseId:   existing.kasseId,
    positionen: belegPositionen,
    zahlung:    zahlungMitTrinkgeld,
    ...(input.rabatt && { rabatt: input.rabatt }),
    ...(input.freigabePin && { freigabePin: input.freigabePin }),
  }, deps.belegDeps, {
    skipLagerstand: true,   // Tisch: Lager läuft über Positionsänderung
    zusatzNachlassCent: posNachlassCent,
    ...(freigabeKontext ? { freigabeKontext } : {}),
  })

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

    // Schreiben (KEIN Lagerabzug — Move ist lagerneutral). Wandern ALLE Artikel
    // weg, wird der Quell-Tab geschlossen (Status 'zusammengefuehrt' wie beim Merge)
    // — ein leerer offener Tisch soll nicht stehen bleiben.
    const quelleLeer = neueQuellPos.length === 0
    const [quellRow] = await tx.update(tischTabs)
      .set(quelleLeer
        ? { positionen: neueQuellPos, status: 'zusammengefuehrt', geschlossenAm: jetzt, updatedAt: jetzt }
        : { positionen: neueQuellPos, updatedAt: jetzt })
      .where(eq(tischTabs.id, quellId)).returning()
    const [zielRow] = await tx.update(tischTabs)
      .set({ positionen: neueZielPos, updatedAt: jetzt })
      .where(eq(tischTabs.id, ziel.id)).returning()
    if (!quellRow || !zielRow) throw new TischTabError(500, 'Umbuchen fehlgeschlagen')

    const anzahl = bewegtePos.reduce((s, p) => s + p.menge, 0)
    await tx.insert(tabEreignisse).values({
      tabId: quellId, mandantId, typ: 'positionen_verschoben',
      details: { richtung: 'raus', zielTabId: ziel.id, zielTisch: zielTischNummer, anzahl, quelleGeschlossen: quelleLeer },
    })
    await tx.insert(tabEreignisse).values({
      tabId: ziel.id, mandantId, typ: 'positionen_verschoben',
      details: { richtung: 'rein', quellTabId: quellId, quellTisch: quelle.tischNummer, anzahl },
    })

    return { quelle: toResponse(quellRow), ziel: toResponse(zielRow) }
  })
}

// ---------------------------------------------------------------------------
// Rechnung teilen (Split)
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Ein Teilbeleg je Zahler: Belegpositionen mit dem Preis der Tab-Position. */
export interface SplitTeilbeleg {
  positionen: BarzahlungsbelegInput['positionen']
  zahlung:    BarzahlungsbelegInput['zahlung']
}

function euro(cent: number): string {
  return `${(cent / 100).toFixed(2).replace('.', ',')} €`
}

/**
 * Schlüssel einer Split-Position: Artikel + Optionen (mit Anzahl) + Preis. Der
 * Preis gehört dazu — er ist Teil dessen, was bestellt wurde (Options-Aufpreis,
 * Happy Hour, Preis zum Bestellzeitpunkt), und genau er kommt auf den Teilbeleg.
 */
function splitSchluessel(p: TabPosition): string {
  const mods = (p.modifikatoren ?? []).map(m => `${m.modifikatorId}*${m.menge ?? 1}`).sort().join(',')
  return `${p.artikelId}::${mods}::${p.preisBruttoCent}`
}

/**
 * Prüft eine Aufteilung gegen den Tab — rein rechnerisch, VOR jedem Beleg:
 * jede Zahler-Position muss es so am Tisch geben, alle Zahler zusammen decken
 * den Tab exakt ab (nichts vergessen, nichts dazu), und jeder Zahler zahlt genau
 * seine Summe. Liefert je Zahler die Belegpositionen — mit dem Preis der
 * Tab-Position, nicht dem aus der Anfrage oder dem Artikelstamm.
 */
export function pruefeAufteilung(
  tabPositionen: TabPosition[],
  zahlungen:     TischTabSplittenInput['zahlungen'],
): SplitTeilbeleg[] {
  // Noch zu verteilende Menge je Schlüssel (gleiche Position aus mehreren Runden zusammen)
  const offen = new Map<string, { menge: number; position: TabPosition }>()
  for (const p of tabPositionen) {
    const k  = splitSchluessel(p)
    const ex = offen.get(k)
    if (ex) ex.menge += p.menge
    else offen.set(k, { menge: p.menge, position: p })
  }

  const teilbelege = zahlungen.map((z, i): SplitTeilbeleg => {
    const zahler = `Zahler ${i + 1}`
    let summeCent = 0
    const positionen = z.positionen.map(p => {
      const eintrag = offen.get(splitSchluessel(p))
      if (!eintrag) {
        throw new TischTabError(400, `${zahler}: „${p.bezeichnung}" steht so nicht (mehr) auf dem Tisch — bitte neu laden`)
      }
      if (p.menge > eintrag.menge) {
        throw new TischTabError(400, `${zahler}: „${p.bezeichnung}" ist öfter aufgeteilt als bestellt`)
      }
      eintrag.menge -= p.menge
      const t = eintrag.position
      summeCent += t.preisBruttoCent * p.menge
      return {
        artikelId:              t.artikelId,
        menge:                  p.menge,
        einzelpreisBreuttoCent: t.preisBruttoCent,
        ...(t.modifikatoren?.length
          ? { bezeichnungZusatz: t.modifikatoren.map(m => m.name).join(', ').slice(0, 200) }
          : {}),
      }
    })
    const gezahltCent = z.zahlung.barCent + z.zahlung.karteCent + z.zahlung.sonstigeCent
    if (gezahltCent !== summeCent) {
      throw new TischTabError(400, `${zahler}: Zahlung ${euro(gezahltCent)} passt nicht zur Summe ${euro(summeCent)}`)
    }
    return { positionen, zahlung: z.zahlung }
  })

  const vergessen = [...offen.values()].filter(e => e.menge > 0)
  if (vergessen.length > 0) {
    throw new TischTabError(400,
      `Nicht alles aufgeteilt: ${vergessen.map(e => `${e.menge}× ${e.position.bezeichnung}`).join(', ')}`)
  }
  return teilbelege
}

/**
 * Kann die Kasse die Teilbelege jetzt ausstellen? Prüft VOR dem ersten Beleg,
 * woran die Belegerstellung sonst erst mitten im Split scheitern würde: Kasse
 * in Betrieb, SEE-Zertifikat gültig, alle Artikel des Tabs noch aktiv. (Die
 * Belegerstellung prüft das noch einmal selbst — scheitert sie dennoch, rollt
 * die Transaktion alle Teilbelege zurück.)
 */
async function pruefeBelegbereit(
  tx:         Tx,
  kasseId:    string,
  mandantId:  string,
  positionen: TabPosition[],
): Promise<void> {
  const [kasse] = await tx
    .select({ status: kassen.status, seeGueltigBis: kassen.seeGueltigBis })
    .from(kassen)
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new TischTabError(404, 'Kasse nicht gefunden')
  if (kasse.status !== 'aktiv') throw new TischTabError(409, `Kasse ist ${kasse.status}, keine neuen Belege möglich`)
  if (kasse.seeGueltigBis <= new Date()) {
    throw new TischTabError(409,
      `SEE-Zertifikat ist abgelaufen (${kasse.seeGueltigBis.toISOString().slice(0, 10)}). Die Kasse kann keine Belege mehr ausstellen.`)
  }

  const artikelIds = [...new Set(positionen.map(p => p.artikelId))]
  if (artikelIds.length === 0) return
  const aktiv = await tx
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(inArray(artikel.id, artikelIds), eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true)))
  const aktivIds = new Set(aktiv.map(a => a.id))
  const weg = [...new Set(positionen.filter(p => !aktivIds.has(p.artikelId)).map(p => p.bezeichnung))]
  if (weg.length > 0) {
    throw new TischTabError(409,
      `Nicht mehr verfügbar: ${weg.join(', ')} — Artikel wieder aktivieren oder vom Tisch nehmen`)
  }
}

/**
 * Rechnung teilen: je Zahler ein eigener RKSV-Beleg — ALLES ODER NICHTS.
 *
 *  1. Tab sperren (FOR UPDATE): ein doppelt abgeschickter Split wartet und
 *     findet danach „bereits bezahlt", statt ein zweites Mal zu buchen.
 *  2. ALLE Zahler prüfen, bevor der erste Beleg entsteht (pruefeAufteilung,
 *     pruefeBelegbereit).
 *  3. Teilbelege in DIESER Transaktion erstellen, dann den Tab schließen.
 *     Scheitert irgendetwas — auch unerwartet beim n-ten Beleg —, rollt alles
 *     zurück: kein Beleg, Belegnummer/Umsatzzähler/Signaturkette unverändert,
 *     Tab offen. Ein erneuter Versuch bucht nichts doppelt.
 *
 * Preise kommen aus der Tab-Position (inkl. Options-Aufpreis) wie bei bezahleTab —
 * die Anfrage legt nur fest, wer was zahlt.
 */
export async function splitteUndBezahleTab(
  id: string,
  input: TischTabSplittenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<{ tab: TischTabResponse; belegIds: string[] }> {
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(tischTabs)
      .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
      .for('update')
      .limit(1)
    if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
    if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist bereits bezahlt')

    const tabPositionen = (existing.positionen as TabPosition[]) ?? []
    const teilbelege    = pruefeAufteilung(tabPositionen, input.zahlungen)
    await pruefeBelegbereit(tx, existing.kasseId, mandantId, tabPositionen)

    // Mit tx als db öffnet die Belegerstellung statt einer eigenen Transaktion
    // einen Savepoint (drizzle: verschachteltes transaction()). Die Kassensperre
    // hält so bis zum COMMIT — die Teilbelege bekommen aufeinanderfolgende
    // Nummern, und ein Rollback nimmt sie alle mit. Der Split nutzt keinen
    // Kunden und keinen Rabatt, die Belegerstellung braucht hier nur Abfragen.
    const belegDeps: BelegServiceDeps = { ...deps.belegDeps, db: tx as unknown as Db }
    const belegIds: string[] = []
    for (const [i, teil] of teilbelege.entries()) {
      try {
        const beleg = await erstelleBarzahlungsbeleg({
          kasseId:    existing.kasseId,
          positionen: teil.positionen,
          zahlung:    teil.zahlung,
        }, belegDeps, { skipLagerstand: true })  // Tisch: Lager läuft über Positionsänderung
        belegIds.push(beleg.id)
      } catch (err) {
        if (err instanceof BelegError) throw new TischTabError(err.httpStatus, `Zahler ${i + 1}: ${err.message}`)
        throw err
      }
    }

    const jetzt = new Date()
    const [row] = await tx
      .update(tischTabs)
      .set({ status: 'bezahlt', geschlossenAm: jetzt, updatedAt: jetzt })
      .where(eq(tischTabs.id, id))
      .returning()
    if (!row) throw new TischTabError(500, 'Tab konnte nicht geschlossen werden')

    await tx.insert(tabEreignisse).values({
      tabId: id, mandantId, typ: 'gesplittet',
      details: { anzahlZahler: teilbelege.length, belegIds, gesamtCent: berechneGesamtCent(tabPositionen) },
    })

    return { tab: toResponse(row), belegIds }
  })
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

// ---------------------------------------------------------------------------
// Gänge-Steuerung (Coursing) — nächsten Gang feuern / Position nachschicken
// ---------------------------------------------------------------------------

/** „nichts zu bonieren" (Artikel ohne Station/Drucker) schlucken — wie im Frontend. */
async function bonierTolerant(
  input: Parameters<typeof bonierBestellung>[0],
  db:    Db,
): Promise<void> {
  try {
    await bonierBestellung(input, { db })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (!/nichts zu bonieren/i.test(msg)) throw err
  }
}

/**
 * Feuert den nächsten offenen Gang: kleinster `gang > 0` mit `gesendetAm == null`.
 * Boniert nur diese Positionen (ohne Lagerabzug — der lief beim Buchen) und markiert
 * sie als gesendet. Der Gang steht als Suffix im Tisch-Label auf dem Bon.
 */
export async function rufeNaechstenGangAb(
  id: string, mandantId: string, deps: TischTabServiceDeps,
): Promise<{ tab: TischTabResponse; gang: number }> {
  const [tab] = await deps.db
    .select().from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId))).limit(1)
  if (!tab) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (tab.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  const positionen = (tab.positionen as TabPosition[]) ?? []
  const offeneGaenge = positionen.filter(p => (p.gang ?? 0) > 0 && !p.gesendetAm).map(p => p.gang!)
  if (offeneGaenge.length === 0) throw new TischTabError(409, 'Kein offener Gang zum Abrufen')
  const naechster = Math.min(...offeneGaenge)

  const gangPositionen = positionen.filter(p => (p.gang ?? 0) === naechster && !p.gesendetAm)
  await bonierTolerant({
    kasseId:    tab.kasseId,
    tabId:      tab.id,
    tisch:      `${tab.tischNummer} · ${naechster}. Gang`.slice(0, 40),
    kellner:    tab.kellner,
    positionen: gangPositionen.map(p => ({ artikelId: p.artikelId, menge: p.menge, gang: naechster })),
    ohneLagerabzug: true,
  }, deps.db)

  const jetzt = new Date().toISOString()
  const neuePositionen = positionen.map(p =>
    (p.gang ?? 0) === naechster && !p.gesendetAm ? { ...p, gesendetAm: jetzt } : p,
  )
  const [row] = await deps.db
    .update(tischTabs)
    .set({ positionen: neuePositionen, updatedAt: new Date() })
    .where(eq(tischTabs.id, id)).returning()
  await logEreignis(id, mandantId, 'gang_gefeuert', { gang: naechster, positionen: gangPositionen.length }, deps.db)
  return { tab: toResponse(row!), gang: naechster }
}

/** Schickt genau eine Position erneut an Küche/Schank (Re-Print) — Status unverändert. */
export async function schickePositionNach(
  id: string, positionIndex: number, mandantId: string, deps: TischTabServiceDeps,
): Promise<void> {
  const [tab] = await deps.db
    .select().from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId))).limit(1)
  if (!tab) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  const positionen = (tab.positionen as TabPosition[]) ?? []
  const p = positionen[positionIndex]
  if (!p) throw new TischTabError(404, 'Position nicht gefunden')

  const gang = p.gang ?? 0
  const label = gang > 0 ? `${tab.tischNummer} · ${gang}. Gang ↻` : `${tab.tischNummer} · ↻`
  await bonierTolerant({
    kasseId:    tab.kasseId,
    tabId:      tab.id,
    tisch:      label.slice(0, 40),
    kellner:    tab.kellner,
    positionen: [{ artikelId: p.artikelId, menge: p.menge, gang }],
    ohneLagerabzug: true,
  }, deps.db)
  await logEreignis(id, mandantId, 'gang_nachgeschickt', { bezeichnung: p.bezeichnung, gang }, deps.db)
}
