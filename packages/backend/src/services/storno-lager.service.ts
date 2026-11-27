/**
 * Storno → Lagerstand zurückbuchen.
 *
 * Jede bezahlte Artikelposition wurde beim Verkauf genau einmal vom Lager abgebucht (Direktkassieren im Beleg,
 * Küchen-/Schankartikel beim Bonieren, am Tisch über die Positionsänderungen). Ein Storno bucht zurück — aber nur,
 * was wirklich zurück ins Lager kann: Eine Flasche ja, ein zubereitetes Schnitzel (Rezeptur) nein.
 *
 * Vorgabe je Artikel (artikel.storno_lager_rueck): null = automatisch (ohne Rezeptur ja, mit Rezeptur nein),
 * true/false = fest. Beim Storno wählt die Bedienung je Position (StornobelegInput.lagerZurueck, Indizes der
 * Positionen des Originalbelegs). Ohne Angabe gilt die Vorgabe.
 *
 * Zuordnung Position → Artikel: über die Artikel-ID der Position; ältere Belege kennen nur den Namen (eindeutig).
 */

import { and, eq, sql } from 'drizzle-orm'
import { artikel } from '../db/schema.js'
import { ladeRezepte, summiereBedarf, type DbOrTx } from './bestandteil.service.js'

export interface StornoLagerPosition {
  /** Index der Position im Originalbeleg */
  index:       number
  bezeichnung: string
  menge:       number
  artikelId:   string | null
  /** Hat die Position überhaupt eine Lagerwirkung (Lagerartikel oder Rezeptur)? */
  wirkung:     boolean
  /** Vorgabe: zurück ins Lager? */
  vorschlag:   boolean
  /** Woher die Vorgabe kommt — für die Anzeige */
  grund:       string
}

type GespeichertePosition = { bezeichnung: string; menge: number; artikelId?: string; artikelName?: string }

export async function bewerteStornoLager(
  db: DbOrTx,
  mandantId: string,
  positionen: GespeichertePosition[],
): Promise<StornoLagerPosition[]> {
  const alle = await db.select({
    id: artikel.id, bezeichnung: artikel.bezeichnung, lagerstandAktiv: artikel.lagerstandAktiv, stornoLagerRueck: artikel.stornoLagerRueck,
  }).from(artikel).where(eq(artikel.mandantId, mandantId))
  const nachId = new Map(alle.map(a => [a.id, a]))
  const nachName = new Map<string, string | null>()
  for (const a of alle) nachName.set(a.bezeichnung, nachName.has(a.bezeichnung) ? null : a.id)

  const zuordnung = positionen.map(p => {
    if (p.artikelId && nachId.has(p.artikelId)) return nachId.get(p.artikelId)!
    const id = p.artikelName ? nachName.get(p.artikelName) : null
    return id ? nachId.get(id)! : null
  })
  const rezepte = await ladeRezepte(db, mandantId, [...new Set(zuordnung.filter(a => a !== null).map(a => a.id))])

  return positionen.map((p, index) => {
    const a = zuordnung[index] ?? null
    const basis = { index, bezeichnung: p.bezeichnung, menge: p.menge, artikelId: a?.id ?? null }
    if (!a) return { ...basis, wirkung: false, vorschlag: false, grund: 'kein Lagerartikel' }
    const hatRezept = (rezepte.get(a.id)?.length ?? 0) > 0
    const wirkung = a.lagerstandAktiv || hatRezept
    if (!wirkung) return { ...basis, wirkung: false, vorschlag: false, grund: 'ohne Lagerführung' }
    if (a.stornoLagerRueck !== null) {
      return { ...basis, wirkung, vorschlag: a.stornoLagerRueck, grund: a.stornoLagerRueck ? 'Vorgabe am Artikel: zurück' : 'Vorgabe am Artikel: nicht zurück' }
    }
    return hatRezept
      ? { ...basis, wirkung, vorschlag: false, grund: 'Rezeptur (zubereitet)' }
      : { ...basis, wirkung, vorschlag: true, grund: 'Ware' }
  })
}

/**
 * Bucht die gewählten Positionen zurück (Artikel mit Lagerführung + Rohstoffe der Rezeptur).
 * Liefert die Indizes, die tatsächlich zurückgebucht wurden.
 */
export async function bucheStornoLagerZurueck(
  tx: DbOrTx,
  mandantId: string,
  bewertung: StornoLagerPosition[],
  gewaehlt: Set<number>,
): Promise<Set<number>> {
  const zurueck = bewertung.filter(b => b.wirkung && b.artikelId !== null && gewaehlt.has(b.index))
  if (zurueck.length === 0) return new Set()

  const mengen = new Map<string, number>()
  for (const b of zurueck) mengen.set(b.artikelId!, (mengen.get(b.artikelId!) ?? 0) + b.menge)
  const rezepte = await ladeRezepte(tx, mandantId, [...mengen.keys()])
  const bestandteile = summiereBedarf([...mengen].map(([artikelId, delta]) => ({ artikelId, delta })), rezepte)

  const gutschreiben = async (id: string, menge: number) => {
    if (menge <= 0) return
    await tx.update(artikel)
      .set({ lagerstandMenge: sql`COALESCE(${artikel.lagerstandMenge}, 0) + ${menge}`, updatedAt: new Date() })
      .where(and(eq(artikel.id, id), eq(artikel.mandantId, mandantId), eq(artikel.lagerstandAktiv, true)))
  }
  for (const [id, menge] of mengen) await gutschreiben(id, menge)
  for (const [id, menge] of bestandteile) await gutschreiben(id, menge)

  return new Set(zurueck.map(b => b.index))
}
