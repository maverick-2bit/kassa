/**
 * Sauberer Neustart des Katalogs (Layout-Import mit katalogLoeschen=true): löscht ALLE Artikel,
 * Warengruppen und Optionsgruppen des Mandanten — hart (DELETE), nicht rückgängig.
 *
 * Belege, Belegpositionen, RKSV-/DEP-/Signaturdaten, Tagesabschlüsse, Kassenbuch und Audit-Log
 * werden NIE angefasst: Belege tragen ihre Positionen als jsonb-Snapshot (Bezeichnung, Preis,
 * Warengruppenname) ohne Fremdschlüssel auf den Artikel — Ansicht, Druck, Archiv, Bericht und
 * DEP-Export funktionieren ohne den Artikelstamm weiter (Integrationstest).
 *
 * Verweise auf Artikel/Warengruppen:
 *  - Harte FKs ohne Cascade: seriennummern, inventur_positionen → werden mitgelöscht (Bestandsdaten
 *    am Artikel); artikel.kategorie_id → Artikel zuerst, dann Gruppen.
 *  - Cascade/Set-null: artikel_bestandteile, artikel_modifikator_gruppen, kasse_favoriten,
 *    kasse_artikel_layout (Anordnung je Kasse + Warengruppe: jede Zeile hängt an Artikel UND Warengruppe,
 *    verschwindet also mit ihnen; für behaltene/deaktivierte bleibt sie als unsichtbarer Altbestand),
 *    kasse_kategorie_sichtbarkeit, kassen.start_kategorie_id, kategorien.parent_id.
 *  - jsonb ohne FK: preisregeln (kategorie_ids, artikel_ids, artikel_preise) → bereinigt; wird eine
 *    eingegrenzte Regel dadurch scope-los (würde sonst für ALLE Artikel gelten), wird sie deaktiviert.
 *  - FALLBACK: Artikel mit laufenden Vorgängen (offener Tisch, laufende SB-/Gast-Bestellung, offene
 *    Inventur) bleiben erhalten und werden nur DEAKTIVIERT (samt Bestandteilen ihres Rezepts und
 *    ihrer Warengruppen), mit Grund im Bericht.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  artikel, artikelBestandteile, gastBestellungen, inventuren, inventurPositionen, kassekategorieSichtbarkeit,
  kassen, kasseFavoriten, kategorien, modifikatorGruppen, preisregeln, sbBestellungen, seriennummern, tischTabs,
} from '../db/schema.js'

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface PreisregelBereinigung {
  id: string
  artikelIds: string[]
  kategorieIds: string[]
  artikelPreise: unknown[]
  aktiv: boolean
}

export interface LoeschPlan {
  artikelLoeschen: number
  gruppenLoeschen: number
  optionsgruppen: number
  seriennummern: number
  inventurPositionen: number
  sichtbarkeiten: number
  /** nur deaktiviert wegen Verweisen */
  artikelBehalten: { id: string; bezeichnung: string; grund: string }[]
  gruppenBehalten: { id: string; name: string; grund: string }[]
  preisregeln: PreisregelBereinigung[]
}

const ids = (json: unknown): string[] =>
  Array.isArray(json)
    ? json.map(p => (p && typeof p === 'object' ? (p as { artikelId?: unknown }).artikelId : undefined))
        .filter((x): x is string => typeof x === 'string')
    : []

/** Ermittelt (read-only), was gelöscht und was nur deaktiviert würde. */
export async function ermittleLoeschPlan(tx: Tx, mandantId: string): Promise<LoeschPlan> {
  const alleArtikel = await tx.select({ id: artikel.id, bezeichnung: artikel.bezeichnung, kategorieId: artikel.kategorieId })
    .from(artikel).where(eq(artikel.mandantId, mandantId))
  const alleGruppen = await tx.select({ id: kategorien.id, name: kategorien.name })
    .from(kategorien).where(eq(kategorien.mandantId, mandantId))
  const bezeichnung = new Map(alleArtikel.map(a => [a.id, a.bezeichnung] as const))
  const behalten = new Map<string, string>() // artikelId → Grund
  const merke = (liste: string[], grund: string) => {
    for (const id of liste) if (bezeichnung.has(id) && !behalten.has(id)) behalten.set(id, grund)
  }

  for (const t of await tx.select({ p: tischTabs.positionen }).from(tischTabs)
    .where(and(eq(tischTabs.mandantId, mandantId), eq(tischTabs.status, 'offen')))) merke(ids(t.p), 'offener Tisch')
  for (const b of await tx.select({ p: sbBestellungen.positionen }).from(sbBestellungen)
    .where(and(eq(sbBestellungen.mandantId, mandantId), inArray(sbBestellungen.status, ['zahlung', 'offen', 'bereit'])))) {
    merke(ids(b.p), 'laufende SB-Bestellung')
  }
  for (const b of await tx.select({ p: gastBestellungen.positionen }).from(gastBestellungen)
    .where(and(eq(gastBestellungen.mandantId, mandantId), eq(gastBestellungen.status, 'zahlung')))) {
    merke(ids(b.p), 'laufende Gast-Bestellung')
  }
  merke((await tx.select({ id: inventurPositionen.artikelId }).from(inventurPositionen)
    .innerJoin(inventuren, eq(inventurPositionen.inventurId, inventuren.id))
    .where(and(eq(inventuren.mandantId, mandantId), eq(inventuren.status, 'offen')))).map(r => r.id), 'offene Inventur')

  // Rezept: Bestandteile eines behaltenen Verkaufsartikels bleiben (sonst ginge das Rezept still verloren)
  const rezepte = await tx.select({ v: artikelBestandteile.verkaufsartikelId, b: artikelBestandteile.bestandteilArtikelId })
    .from(artikelBestandteile).where(eq(artikelBestandteile.mandantId, mandantId))
  for (const r of rezepte) {
    if (behalten.has(r.v) && !behalten.has(r.b) && bezeichnung.has(r.b)) {
      behalten.set(r.b, `Bestandteil von „${bezeichnung.get(r.v)}"`)
    }
  }

  const gruppenBehalten = new Map<string, string>()
  for (const a of alleArtikel) if (behalten.has(a.id) && a.kategorieId) gruppenBehalten.set(a.kategorieId, 'enthält Artikel mit laufenden Vorgängen')
  const keptA = [...behalten.keys()]
  const keptG = [...gruppenBehalten.keys()]

  const zaehle = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0
  const [og, sn, ip, sv] = await Promise.all([
    zaehle(tx.select({ n: sql<number>`count(*)::int` }).from(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandantId))),
    zaehle(tx.select({ n: sql<number>`count(*)::int` }).from(seriennummern)
      .where(and(eq(seriennummern.mandantId, mandantId), keptA.length ? notInArray(seriennummern.artikelId, keptA) : undefined))),
    zaehle(tx.select({ n: sql<number>`count(*)::int` }).from(inventurPositionen)
      .innerJoin(inventuren, eq(inventurPositionen.inventurId, inventuren.id))
      .where(and(eq(inventuren.mandantId, mandantId), keptA.length ? notInArray(inventurPositionen.artikelId, keptA) : undefined))),
    zaehle(tx.select({ n: sql<number>`count(*)::int` }).from(kassekategorieSichtbarkeit)
      .innerJoin(kassen, eq(kassekategorieSichtbarkeit.kasseId, kassen.id)).where(eq(kassen.mandantId, mandantId))),
  ])

  // Preisregeln bereinigen
  const weg = new Set(alleArtikel.filter(a => !behalten.has(a.id)).map(a => a.id))
  const wegG = new Set(alleGruppen.filter(g => !gruppenBehalten.has(g.id)).map(g => g.id))
  const bereinigungen: PreisregelBereinigung[] = []
  for (const r of await tx.select().from(preisregeln).where(eq(preisregeln.mandantId, mandantId))) {
    const aIds = (r.artikelIds as string[]) ?? [], kIds = (r.kategorieIds as string[]) ?? []
    const preise = (r.artikelPreise as { artikelId?: string }[]) ?? []
    const aNeu = aIds.filter(x => !weg.has(x)), kNeu = kIds.filter(x => !wegG.has(x))
    const pNeu = preise.filter(p => !(p.artikelId && weg.has(p.artikelId)))
    if (aNeu.length === aIds.length && kNeu.length === kIds.length && pNeu.length === preise.length) continue
    const warEingegrenzt = aIds.length + kIds.length > 0
    const aktiv = r.aktiv && !(warEingegrenzt && aNeu.length + kNeu.length === 0)
    bereinigungen.push({ id: r.id, artikelIds: aNeu, kategorieIds: kNeu, artikelPreise: pNeu, aktiv })
  }

  return {
    artikelLoeschen: alleArtikel.length - keptA.length,
    gruppenLoeschen: alleGruppen.length - keptG.length,
    optionsgruppen: og, seriennummern: sn, inventurPositionen: ip, sichtbarkeiten: sv,
    artikelBehalten: keptA.map(id => ({ id, bezeichnung: bezeichnung.get(id)!, grund: behalten.get(id)! })),
    gruppenBehalten: alleGruppen.filter(g => gruppenBehalten.has(g.id)).map(g => ({ id: g.id, name: g.name, grund: gruppenBehalten.get(g.id)! })),
    preisregeln: bereinigungen,
  }
}

/** Führt die Löschung aus (in der Transaktion des Aufrufers; Fehler → Rollback des Ganzen). */
export async function fuehreLoeschungAus(tx: Tx, mandantId: string, plan: LoeschPlan): Promise<void> {
  const jetzt = new Date()
  const keptA = plan.artikelBehalten.map(a => a.id)
  const keptG = plan.gruppenBehalten.map(g => g.id)

  if (keptA.length > 0) {
    await tx.update(artikel).set({ aktiv: false, istFavorit: false, updatedAt: jetzt }).where(inArray(artikel.id, keptA))
  }
  if (keptG.length > 0) {
    await tx.update(kategorien).set({ aktiv: false, updatedAt: jetzt }).where(inArray(kategorien.id, keptG))
  }

  // Abhängige Zeilen zuerst (FKs ohne Cascade)
  await tx.delete(seriennummern)
    .where(and(eq(seriennummern.mandantId, mandantId), keptA.length ? notInArray(seriennummern.artikelId, keptA) : undefined))
  const inventurIds = (await tx.select({ id: inventuren.id }).from(inventuren).where(eq(inventuren.mandantId, mandantId))).map(i => i.id)
  if (inventurIds.length > 0) {
    await tx.delete(inventurPositionen)
      .where(and(inArray(inventurPositionen.inventurId, inventurIds), keptA.length ? notInArray(inventurPositionen.artikelId, keptA) : undefined))
  }

  // Kassen-Listen: Favoriten + Sichtbarkeit der Warengruppen leeren, Start-Reiter zurücksetzen
  await tx.delete(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantId))
  const kassenIds = (await tx.select({ id: kassen.id }).from(kassen).where(eq(kassen.mandantId, mandantId))).map(k => k.id)
  if (kassenIds.length > 0) {
    await tx.delete(kassekategorieSichtbarkeit).where(inArray(kassekategorieSichtbarkeit.kasseId, kassenIds))
    await tx.update(kassen).set({ startKategorieId: null }).where(inArray(kassen.id, kassenIds))
  }

  // Artikel (kaskadiert Rezepte/Optionszuordnungen), Optionsgruppen (kaskadiert Optionen), dann Gruppen
  await tx.delete(artikel).where(and(eq(artikel.mandantId, mandantId), keptA.length ? notInArray(artikel.id, keptA) : undefined))
  await tx.delete(modifikatorGruppen).where(eq(modifikatorGruppen.mandantId, mandantId))
  await tx.delete(kategorien).where(and(eq(kategorien.mandantId, mandantId), keptG.length ? notInArray(kategorien.id, keptG) : undefined))

  for (const r of plan.preisregeln) {
    await tx.update(preisregeln)
      .set({ artikelIds: r.artikelIds, kategorieIds: r.kategorieIds, artikelPreise: r.artikelPreise, aktiv: r.aktiv, updatedAt: jetzt })
      .where(and(eq(preisregeln.id, r.id), eq(preisregeln.mandantId, mandantId)))
  }
}
