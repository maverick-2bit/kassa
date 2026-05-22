/**
 * Tagesabschluss-Service (Z-Bon)
 *
 * Aggregiert alle Barzahlungs- und Stornobelege eines Tages (Wiener Ortszeit)
 * für eine Kasse zu einem Tagesabschluss-Objekt.
 *
 * Datum-Filter: Verwendet AT TIME ZONE 'Europe/Vienna' direkt in PostgreSQL,
 * damit Sommer-/Winterzeit korrekt berücksichtigt wird.
 */

import { and, eq, inArray, sql, sum } from 'drizzle-orm'
import { MWST_LABELS, type MwStSatz, type Tagesabschluss } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { belege } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

/** Steuersätze in Prozent */
const MWST_SAETZE: Record<MwStSatz, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:         0,
  besonders:   19,
}

export class TagesabschlussError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface TagesabschlussServiceDeps {
  db: Db
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function holeTagesabschluss(
  kasseId:   string,
  datum:     string,           // YYYY-MM-DD
  mandantId: string,
  deps:      TagesabschlussServiceDeps,
): Promise<Tagesabschluss> {
  // Mandant-Scope-Prüfung
  const gehoert = await pruefeKasseGehoertZuMandant(deps.db, kasseId, mandantId)
  if (!gehoert) throw new TagesabschlussError(404, 'Kasse nicht gefunden')

  // Alle Barzahlungs- und Stornobelege des Tages laden
  // DATE(...) AT TIME ZONE 'Europe/Vienna' → korrekte Tagesgrenze für Wien
  const rows = await deps.db
    .select()
    .from(belege)
    .where(
      and(
        eq(belege.kasseId, kasseId),
        inArray(belege.belegTyp, ['Barzahlungsbeleg', 'Stornobeleg']),
        sql`(${belege.belegDatum} at time zone 'Europe/Vienna')::date = ${datum}::date`,
      ),
    )

  // Aggregieren
  let anzahlBarzahlungsbelege = 0
  let anzahlStornobelege      = 0
  let nettoUmsatzCent         = 0
  let barCent                 = 0
  let karteCent               = 0
  let sonstigCent             = 0

  const mwstSummen: Record<MwStSatz, number> = {
    normal:      0,
    ermaessigt1: 0,
    ermaessigt2: 0,
    null:        0,
    besonders:   0,
  }

  for (const row of rows) {
    if (row.belegTyp === 'Barzahlungsbeleg') anzahlBarzahlungsbelege++
    if (row.belegTyp === 'Stornobeleg')      anzahlStornobelege++

    const gesamt = row.betragNormalCent + row.betragErmaessigt1Cent +
                   row.betragErmaessigt2Cent + row.betragNullCent + row.betragBesondersCent

    nettoUmsatzCent += gesamt
    barCent         += row.summeBarCent
    karteCent       += row.summeKarteCent
    sonstigCent     += row.summeSonstigeCent

    mwstSummen.normal      += row.betragNormalCent
    mwstSummen.ermaessigt1 += row.betragErmaessigt1Cent
    mwstSummen.ermaessigt2 += row.betragErmaessigt2Cent
    mwstSummen.null        += row.betragNullCent
    mwstSummen.besonders   += row.betragBesondersCent
  }

  // MwSt-Zeilen aufbauen (nur Sätze mit ≠ 0)
  const satzKeys: MwStSatz[] = ['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders']
  const mwst = satzKeys
    .filter((k) => mwstSummen[k] !== 0)
    .map((k) => {
      const bruttoCent = mwstSummen[k]
      const prozent    = MWST_SAETZE[k]
      // Brutto = Netto × (1 + p/100)  →  Netto = round(Brutto / (1 + p/100))
      const nettoCent  = prozent === 0 ? bruttoCent : Math.round(bruttoCent / (1 + prozent / 100))
      const ustCent    = bruttoCent - nettoCent
      return { satzKey: k, label: MWST_LABELS[k], bruttoCent, nettoCent, ustCent }
    })

  return {
    datum,
    kasseId,
    anzahlBarzahlungsbelege,
    anzahlStornobelege,
    nettoUmsatzCent,
    barCent,
    karteCent,
    sonstigCent,
    mwst,
  }
}
