/**
 * Empfang der Meldungen der Boxen.
 *
 * Eine Box ruft von sich aus `POST /api/box/meldung` mit ihrem Token auf. Das Portal prüft das Token (gespeichert ist
 * nur der Hash), prüft die Meldung gegen das Schema (die Grenze dessen, was die Box schicken darf), merkt sich die
 * letzte Meldung samt Zeitpunkt und zählt die Fehlerberichte je Fehlergruppe zusammen.
 */

import { and, eq, lt, sql } from 'drizzle-orm'
import type { PortalMeldung } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { portalBetriebe, portalBoxen, portalFehler } from '../db/schema.js'
import { hashToken } from '../auth/box-token.js'

/** Fehlerberichte, die länger nicht mehr aufgetreten sind, werden gelöscht. */
export const FEHLER_AUFBEWAHRUNG_TAGE = 90

export interface BoxKontext {
  boxId:     string
  boxName:   string
  betriebId: string
}

/** Box zum Token finden — nur aktive Boxen aktiver Betriebe. */
export async function findeBoxPerToken(db: Db, token: string): Promise<BoxKontext | null> {
  const [zeile] = await db
    .select({ boxId: portalBoxen.id, boxName: portalBoxen.name, betriebId: portalBoxen.betriebId })
    .from(portalBoxen)
    .innerJoin(portalBetriebe, eq(portalBetriebe.id, portalBoxen.betriebId))
    .where(and(eq(portalBoxen.tokenHash, hashToken(token)), eq(portalBoxen.aktiv, true), eq(portalBetriebe.aktiv, true)))
    .limit(1)
  return zeile ?? null
}

export async function verarbeiteMeldung(db: Db, box: BoxKontext, meldung: PortalMeldung, jetzt: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(portalBoxen)
      .set({ zuletztGesehen: jetzt, version: meldung.version, meldung, updatedAt: jetzt })
      .where(eq(portalBoxen.id, box.boxId))

    if (meldung.fehler.length > 0) {
      await tx.insert(portalFehler)
        .values(meldung.fehler.map(f => ({
          boxId:     box.boxId,
          hash:      f.hash,
          name:      f.name,
          meldung:   f.meldung,
          route:     f.route,
          anzahl:    f.anzahl,
          ersterAm:  new Date(f.ersterAm),
          letzterAm: new Date(f.letzterAm),
        })))
        .onConflictDoUpdate({
          target: [portalFehler.boxId, portalFehler.hash],
          set: {
            anzahl:    sql`${portalFehler.anzahl} + excluded.anzahl`,
            ersterAm:  sql`LEAST(${portalFehler.ersterAm}, excluded.erster_am)`,
            letzterAm: sql`GREATEST(${portalFehler.letzterAm}, excluded.letzter_am)`,
            // Der jüngste Wortlaut gilt
            name:      sql`excluded.name`,
            meldung:   sql`excluded.meldung`,
            route:     sql`excluded.route`,
          },
        })
    }

    // Aufräumen: alte Fehlergruppen dieser Box (läuft mit jeder Meldung, trifft aber meist nichts)
    const grenze = new Date(jetzt.getTime() - FEHLER_AUFBEWAHRUNG_TAGE * 86_400_000)
    await tx.delete(portalFehler).where(and(eq(portalFehler.boxId, box.boxId), lt(portalFehler.letzterAm, grenze)))
  })
}
