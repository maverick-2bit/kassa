/**
 * Umsatzbericht-Service
 *
 * Lädt Barzahlungs- und Stornobelege eines flexiblen Zeitraums und
 * aggregiert sie nach Tag, Kalenderwoche oder Monat (Wiener Ortszeit).
 *
 * Datum-Filter: AT TIME ZONE 'Europe/Vienna' direkt in PostgreSQL.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import {
  MWST_LABELS,
  type BerichtFilter,
  type BerichtGesamt,
  type BerichtResponse,
  type BerichtZeile,
  type MwStSatz,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { belege, kassen } from '../db/schema.js'

const MWST_SAETZE: Record<MwStSatz, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:         0,
  besonders:   19,
}

export class BerichtError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface BerichtServiceDeps { db: Db }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function holeUmsatzbericht(
  filter:    BerichtFilter,
  mandantId: string,
  deps:      BerichtServiceDeps,
): Promise<BerichtResponse> {
  // Alle dem Mandanten zugehörigen Kassen-IDs ermitteln
  const alleKassenDesMandanten = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
  const erlaubteIds = new Set(alleKassenDesMandanten.map(k => k.id))

  // Angefragte kasseIds validieren; leere Liste = alle des Mandanten
  const angefragte = filter.kasseIds.length > 0 ? filter.kasseIds : [...erlaubteIds]
  const ungueltige = angefragte.filter(id => !erlaubteIds.has(id))
  if (ungueltige.length > 0) {
    throw new BerichtError(404, `Kasse(n) nicht gefunden: ${ungueltige.join(', ')}`)
  }
  const kasseIds = angefragte

  if (filter.von > filter.bis) {
    throw new BerichtError(400, '"von" muss vor oder gleich "bis" liegen')
  }

  // Belege laden
  const whereKlauses = [
    inArray(belege.kasseId, kasseIds),
    inArray(belege.belegTyp, ['Barzahlungsbeleg', 'Stornobeleg']),
    sql`(${belege.belegDatum} at time zone 'Europe/Vienna')::date
        between ${filter.von}::date and ${filter.bis}::date`,
  ]
  if (filter.nurZielrechnungen) {
    whereKlauses.push(ne(belege.summeSonstigeCent, 0))
  }

  const rows = await deps.db
    .select({
      belegTyp:              belege.belegTyp,
      belegDatum:            belege.belegDatum,
      summeBarCent:          belege.summeBarCent,
      summeKarteCent:        belege.summeKarteCent,
      summeSonstigeCent:     belege.summeSonstigeCent,
      betragNormalCent:      belege.betragNormalCent,
      betragErmaessigt1Cent: belege.betragErmaessigt1Cent,
      betragErmaessigt2Cent: belege.betragErmaessigt2Cent,
      betragNullCent:        belege.betragNullCent,
      betragBesondersCent:   belege.betragBesondersCent,
    })
    .from(belege)
    .where(and(...whereKlauses))
    .orderBy(belege.belegDatum)

  // Perioden-Schlüssel berechnen
  const periodeMap = new Map<string, BerichtZeile>()

  // Globale MwSt-Summen
  const mwstGesamt: Record<MwStSatz, number> = {
    normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0,
  }

  for (const row of rows) {
    const periode = getPeriodeKey(row.belegDatum, filter.gruppierung)
    const umsatz  = row.summeBarCent + row.summeKarteCent + row.summeSonstigeCent

    let zeile = periodeMap.get(periode)
    if (!zeile) {
      zeile = {
        periode,
        anzahlBelege:  0,
        anzahlStornos: 0,
        umsatzCent:    0,
        barCent:       0,
        karteCent:     0,
        sonstigCent:   0,
      }
      periodeMap.set(periode, zeile)
    }

    if (row.belegTyp === 'Barzahlungsbeleg') zeile.anzahlBelege++
    if (row.belegTyp === 'Stornobeleg')      zeile.anzahlStornos++
    zeile.umsatzCent  += umsatz
    zeile.barCent     += row.summeBarCent
    zeile.karteCent   += row.summeKarteCent
    zeile.sonstigCent += row.summeSonstigeCent

    mwstGesamt.normal      += row.betragNormalCent
    mwstGesamt.ermaessigt1 += row.betragErmaessigt1Cent
    mwstGesamt.ermaessigt2 += row.betragErmaessigt2Cent
    mwstGesamt.null        += row.betragNullCent
    mwstGesamt.besonders   += row.betragBesondersCent
  }

  // Zeilen sortiert (Schlüssel sind lexikographisch sortierbar)
  const zeilen = [...periodeMap.values()].sort((a, b) => a.periode.localeCompare(b.periode))

  // Gesamt berechnen
  const gesamt: BerichtGesamt = {
    anzahlBelege:  zeilen.reduce((s, z) => s + z.anzahlBelege, 0),
    anzahlStornos: zeilen.reduce((s, z) => s + z.anzahlStornos, 0),
    umsatzCent:    zeilen.reduce((s, z) => s + z.umsatzCent, 0),
    barCent:       zeilen.reduce((s, z) => s + z.barCent, 0),
    karteCent:     zeilen.reduce((s, z) => s + z.karteCent, 0),
    sonstigCent:   zeilen.reduce((s, z) => s + z.sonstigCent, 0),
    mwst: (Object.keys(mwstGesamt) as MwStSatz[])
      .filter(k => mwstGesamt[k] !== 0)
      .map(k => {
        const bruttoCent = mwstGesamt[k]
        const prozent    = MWST_SAETZE[k]
        const nettoCent  = prozent === 0 ? bruttoCent : Math.round(bruttoCent / (1 + prozent / 100))
        return { satzKey: k, label: MWST_LABELS[k], bruttoCent, nettoCent, ustCent: bruttoCent - nettoCent }
      }),
  }

  return { von: filter.von, bis: filter.bis, kasseIds, zeilen, gesamt }
}

// ---------------------------------------------------------------------------
// Perioden-Schlüssel (Wiener Ortszeit)
// ---------------------------------------------------------------------------

function getPeriodeKey(
  datum:        Date,
  gruppierung:  'tag' | 'woche' | 'monat',
): string {
  // Datum in Wiener Ortszeit als YYYY-MM-DD
  const lokal = datum.toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
  if (gruppierung === 'tag')   return lokal
  if (gruppierung === 'monat') return lokal.slice(0, 7) // YYYY-MM
  // Kalenderwoche (ISO 8601)
  const d = new Date(lokal)
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7) // Donnerstag dieser Woche
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const kw   = 1 + Math.round(
    ((d.valueOf() - jan4.valueOf()) / 86_400_000 - 3 + (jan4.getDay() + 6) % 7) / 7
  )
  return `${d.getFullYear()}-KW${kw.toString().padStart(2, '0')}`
}
