/**
 * Wirksames Bon-Routing (KDS-Station + Bonierdrucker) der Warengruppen und Artikel.
 *
 * Eine Untergruppe ohne eigene Angabe erbt Station und Bonierdrucker von ihrer
 * Elterngruppe — wer an der Hauptgruppe (z. B. "Kellner Getränke") die Station
 * setzt, meint damit auch alle Untergruppen. Gelesen wird dafür der ganze
 * Warengruppen-Baum des Mandanten (wenige Zeilen), nicht nur die Gruppe des Artikels.
 *
 * Pro Kasse können Warengruppen UND Artikel abweichen (Tabelle kasse_routing, „Kassen-Ausnahmen"):
 * Rangfolge Artikel an der Kasse → Artikel allgemein → Warengruppe an der Kasse → Warengruppe allgemein.
 * Die Regel selbst lebt in @kassa/shared (wirksamesKategorieRouting / wirksamesArtikelRouting) —
 * dort stehen auch die Tests; Backend und Oberfläche rechnen dadurch gleich.
 */

import { eq } from 'drizzle-orm'
import {
  wirksamesArtikelRouting,
  wirksamesKategorieRouting,
  type KasseRoutingAusnahme,
  type KategorieRouting,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kasseRouting, kategorien } from '../db/schema.js'

/** Db oder eine Transaktion davon (beide können select). */
type LeseDb = Pick<Db, 'select'>

/** Warengruppen-Zeilen mit ihrer allgemeinen Vorgabe (Station/Bonierdrucker) — Eingabe der Routing-Regel. */
export async function ladeKategorieRoutingZeilen(db: LeseDb, mandantId: string) {
  return db
    .select({
      id:              kategorien.id,
      parentId:        kategorien.parentId,
      station:         kategorien.station,
      bonierdruckerId: kategorien.bonierdruckerId,
    })
    .from(kategorien)
    .where(eq(kategorien.mandantId, mandantId))
}

/** Alle Kassen-Ausnahmen EINER Kasse (Warengruppen und Artikel). */
export async function ladeKasseRoutingAusnahmen(db: LeseDb, kasseId: string): Promise<KasseRoutingAusnahme[]> {
  return db
    .select({
      kategorieId:     kasseRouting.kategorieId,
      artikelId:       kasseRouting.artikelId,
      bonierdruckerId: kasseRouting.bonierdruckerId,
      keinDrucker:     kasseRouting.keinDrucker,
      station:         kasseRouting.station,
      keineStation:    kasseRouting.keineStation,
    })
    .from(kasseRouting)
    .where(eq(kasseRouting.kasseId, kasseId))
}

/**
 * Wirksames Routing je Warengruppe. Mit `kasseId` das Routing DIESER Kasse
 * (Warengruppen-Ausnahmen der Kasse eingerechnet), sonst die allgemeine Vorgabe.
 */
export async function ladeWirksamesRouting(
  db: LeseDb,
  mandantId: string,
  kasseId?: string,
): Promise<Map<string, KategorieRouting>> {
  const rows = await ladeKategorieRoutingZeilen(db, mandantId)
  const ausnahmen = kasseId ? await ladeKasseRoutingAusnahmen(db, kasseId) : []
  return wirksamesKategorieRouting(rows, ausnahmen)
}

/** Bon-Routing einer Kasse: wirksame Warengruppen-Routings und Artikel-Ausnahmen, fertig zum Nachschlagen je Artikel. */
export interface BonRouting {
  gruppen:          Map<string, KategorieRouting>
  artikelAusnahmen: Map<string, KasseRoutingAusnahme>
}

/** Baut das Bon-Routing einer Kasse aus den bereits geladenen Warengruppen-Zeilen und Kassen-Ausnahmen. */
export function baueBonRouting(
  kategorieZeilen: Parameters<typeof wirksamesKategorieRouting>[0],
  ausnahmen: readonly KasseRoutingAusnahme[],
): BonRouting {
  return {
    gruppen: wirksamesKategorieRouting(kategorieZeilen, ausnahmen),
    artikelAusnahmen: new Map(ausnahmen.flatMap(a => (a.artikelId ? [[a.artikelId, a] as const] : []))),
  }
}

export async function ladeBonRouting(db: LeseDb, mandantId: string, kasseId: string): Promise<BonRouting> {
  const rows = await ladeKategorieRoutingZeilen(db, mandantId)
  return baueBonRouting(rows, await ladeKasseRoutingAusnahmen(db, kasseId))
}

/** Wirksames Routing eines Artikels an der Kasse (siehe Rangfolge oben). */
export function wirksamesRoutingVonArtikel(
  routing: BonRouting,
  a: { id: string; kategorieId: string | null; station: string | null; bonierdruckerId: string | null },
): KategorieRouting {
  return wirksamesArtikelRouting(
    a,
    a.kategorieId ? routing.gruppen.get(a.kategorieId) : undefined,
    routing.artikelAusnahmen.get(a.id),
  )
}
