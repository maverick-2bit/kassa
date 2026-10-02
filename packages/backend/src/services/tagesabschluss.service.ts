/**
 * Tagesabschluss-Service (Z-Bon)
 *
 * Aggregiert alle Barzahlungs- und Stornobelege eines Geschäftstags (Wiener
 * Ortszeit) für eine Kasse zu einem Tagesabschluss-Objekt.
 *
 * Datum-Filter: Verwendet AT TIME ZONE 'Europe/Vienna' direkt in PostgreSQL,
 * damit Sommer-/Winterzeit korrekt berücksichtigt wird.
 *
 * Geschäftstag: Beginnt der Tag des Mandanten nicht um 00:00 (z. B. 06:00), läuft
 * der Abschluss von 06:00 bis 06:00 des Folgetags — Schichten über Mitternacht
 * liegen auf einem Tag. Der Z-Bon wird immer aus den Belegen gerechnet, nichts
 * wird gespeichert: alte Abschlüsse ändern sich also nur, wenn man einen
 * Stichtag in die Vergangenheit legt — und das lässt die Einstellung nicht zu.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { MWST_LABELS, istKalendertag, tagesGrenzen, type MwStSatz, type Tagesabschluss } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { tagesBereich } from '../db/datum.js'
import { belege } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'
import { ladeTagesRegel } from './geschaeftstag.service.js'

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

  // Tagesbeginn des Mandanten (leer = 00:00 = Kalendertag, wie bisher)
  const regel = await ladeTagesRegel(deps.db, mandantId)

  // Alle Barzahlungs- und Stornobelege des Tages laden. Bewusst als Zeilen und
  // nicht als SQL-Aggregat wie im Umsatzbericht: die Menge ist hier durch den
  // einen Tag natürlich begrenzt, und der Z-Bon soll so direkt wie möglich aus
  // den Belegen entstehen. Entscheidend ist der index-taugliche Datumsfilter.
  const rows = await deps.db
    .select()
    .from(belege)
    .where(
      and(
        eq(belege.kasseId, kasseId),
        inArray(belege.belegTyp, ['Barzahlungsbeleg', 'Stornobeleg']),
        tagesBereich(sql`${belege.belegDatum}`, datum, regel),
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

  // Zeitraum nur ausweisen, wenn der Tag nicht 00:00–00:00 läuft — sonst bleibt
  // die Antwort byte-identisch zu früher.
  const grenzen = istKalendertag(regel, datum) ? null : tagesGrenzen(regel, datum)

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
    ...(grenzen && { zeitraum: { von: grenzen.von.toISOString(), bis: grenzen.bis.toISOString() } }),
  }
}
